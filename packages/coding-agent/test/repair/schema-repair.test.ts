import { describe, expect, it } from "bun:test";
import type { Tool, ToolCall } from "@veyyon/ai/types";
import { toolWireSchema } from "@veyyon/ai/utils/schema";
import {
	detectAmbiguousRequiredStringRepair,
	detectStrictUnknownKeyRepair,
	MAX_REPAIR_INPUT_BYTES,
	planAliasKeyRepairs,
	repairToolCallArguments,
} from "@veyyon/coding-agent/repair/schema-repair";
import { type } from "arktype";

const sampleTool: Tool = {
	name: "demo",
	description: "demo tool",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string" },
			content: { type: "string" },
		},
		required: ["path"],
	},
};

const strictTool: Tool = {
	name: "demo-strict",
	description: "demo tool with a closed schema",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string" },
			content: { type: "string" },
		},
		required: ["path"],
		additionalProperties: false,
	},
};

// `| string` deliberately: malformed model output can arrive as a raw string,
// and the oversize/adversarial cases exercise exactly that path.
function call(
	args: ToolCall["arguments"] | string,
	tool: Tool = sampleTool,
): ReturnType<typeof repairToolCallArguments> {
	return repairToolCallArguments(tool, {
		type: "toolCall",
		id: "tc-1",
		name: tool.name,
		arguments: args as ToolCall["arguments"],
	});
}

describe("schema repair (A1)", () => {
	it("clean args stay clean", () => {
		const outcome = call({ path: "/tmp/a.txt", content: "hello" });
		expect(outcome.status).toBe("clean");
		if (outcome.status !== "clean") return;
		expect(outcome.arguments).toEqual({ path: "/tmp/a.txt", content: "hello" });
		expect(outcome.hints).toEqual([]);
	});

	it("repairs trailing-comma JSON via parse sentinel", () => {
		const outcome = call({
			__parseError: "Unexpected token",
			__rawJson: '{"path": "/tmp/a.txt",}',
		});
		expect(outcome.status).toBe("repaired");
		if (outcome.status !== "repaired") return;
		expect(outcome.arguments).toEqual({ path: "/tmp/a.txt" });
		expect(outcome.hints.length).toBeGreaterThan(0);
	});

	it("refuses ambiguous missing required strings (no invent)", () => {
		const ambiguity = detectAmbiguousRequiredStringRepair(
			{
				type: "object",
				properties: { path: { type: "string" }, alt: { type: "string" } },
				required: ["path", "alt"],
			},
			{ foo: "a", bar: "b" },
		);
		expect(ambiguity).toBeDefined();

		const multiFieldTool: Tool = {
			...sampleTool,
			parameters: {
				type: "object",
				properties: { path: { type: "string" }, alt: { type: "string" } },
				required: ["path", "alt"],
			},
		};
		const outcome = repairToolCallArguments(multiFieldTool, {
			type: "toolCall",
			id: "tc-2",
			name: "demo",
			arguments: { foo: "a", bar: "b" },
		});
		expect(outcome.status).toBe("unrepairable");
		if (outcome.status !== "unrepairable") return;
		expect(outcome.reason).toContain("Ambiguous repair");
	});

	it("refuses oversize input", () => {
		const huge = "x".repeat(MAX_REPAIR_INPUT_BYTES + 1);
		const outcome = call(huge);
		expect(outcome.status).toBe("unrepairable");
		if (outcome.status !== "unrepairable") return;
		expect(outcome.reason).toContain("repair limit");
	});
});

describe("schema repair — alias/typo key cascade (U4-01)", () => {
	it("renames a clear common-alias key to the declared property (filepath -> path)", () => {
		const outcome = call({ filepath: "/tmp/a.txt", content: "hello" });
		expect(outcome.status).toBe("repaired");
		if (outcome.status !== "repaired") return;
		expect(outcome.arguments).toEqual({ path: "/tmp/a.txt", content: "hello" });
		expect(outcome.hints.some(h => h.includes("filepath -> path"))).toBe(true);
	});

	it("renames a clear common-alias key to the declared property (contents -> content)", () => {
		const outcome = call({ path: "/tmp/a.txt", contents: "hello" });
		expect(outcome.status).toBe("repaired");
		if (outcome.status !== "repaired") return;
		expect(outcome.arguments).toEqual({ path: "/tmp/a.txt", content: "hello" });
	});

	it("renames a clear casing/separator typo to the declared property (Path -> path)", () => {
		const outcome = call({ Path: "/tmp/a.txt" });
		expect(outcome.status).toBe("repaired");
		if (outcome.status !== "repaired") return;
		expect(outcome.arguments).toEqual({ path: "/tmp/a.txt" });
	});

	it("satisfies a missing required field via alias rename instead of flagging it missing", () => {
		// Only the alias key is present; the ambiguity guard for missing
		// required strings must never fire once the rename resolves it.
		const outcome = call({ file: "/tmp/only-alias.txt" });
		expect(outcome.status).toBe("repaired");
		if (outcome.status !== "repaired") return;
		expect(outcome.arguments).toEqual({ path: "/tmp/only-alias.txt" });
	});

	it("clean call with only declared keys is untouched (no false-positive alias rename)", () => {
		const outcome = call({ path: "/tmp/a.txt", content: "hello" });
		expect(outcome.status).toBe("clean");
		if (outcome.status !== "clean") return;
		expect(outcome.arguments).toEqual({ path: "/tmp/a.txt", content: "hello" });
	});

	it("refuses when two unknown keys both alias to the same declared property", () => {
		const plan = planAliasKeyRepairs(
			{ type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			{ filepath: "/a.txt", file: "/b.txt" },
		);
		expect(plan.kind).toBe("ambiguous");

		const outcome = call({ filepath: "/a.txt", file: "/b.txt" });
		expect(outcome.status).toBe("unrepairable");
		if (outcome.status !== "unrepairable") return;
		expect(outcome.reason).toContain("Ambiguous");
		expect(outcome.reason).toContain("filepath");
		expect(outcome.reason).toContain("file");
	});

	it("refuses when an alias key's target already has a value (no silent overwrite)", () => {
		const outcome = call({ path: "/real.txt", filepath: "/decoy.txt" });
		expect(outcome.status).toBe("unrepairable");
		if (outcome.status !== "unrepairable") return;
		expect(outcome.reason).toContain("Ambiguous");
		expect(outcome.reason).toContain("already present");
	});

	it("refuses when a single unknown key matches more than one declared property", () => {
		// "Contents" typo-matches the declared "contents" property (casing) AND
		// alias-matches the declared "content" property; with both declared,
		// the rename must refuse rather than guess which one the call meant.
		const plan = planAliasKeyRepairs(
			{
				type: "object",
				properties: { contents: { type: "string" }, content: { type: "string" } },
			},
			{ Contents: "hello" },
		);
		expect(plan.kind).toBe("ambiguous");
		if (plan.kind !== "ambiguous") return;
		expect(plan.reason).toContain("multiple");
	});

	it("does not touch a genuinely unrecognized key when the schema is not strict (backward compat)", () => {
		const outcome = call({ path: "/tmp/a.txt", unrelatedNoise: "keep-me" });
		expect(outcome.status).toBe("clean");
		if (outcome.status !== "clean") return;
		expect(outcome.arguments).toEqual({ path: "/tmp/a.txt", unrelatedNoise: "keep-me" });
	});

	it("ignores repair-internal '__' sentinel-prefixed keys when planning alias renames", () => {
		// Computed key so this is a genuine own data property named
		// "__proto__" (as JSON.parse would produce), not the object-literal
		// prototype-setting shorthand — this must not pollute the prototype
		// chain or be mistaken for a renameable field.
		const args = { path: "/tmp/a.txt", ["__proto__"]: "not-a-real-field" };
		expect(Object.hasOwn(args, "__proto__")).toBe(true);

		const plan = planAliasKeyRepairs(sampleTool.parameters as Record<string, unknown>, args);
		expect(plan.kind).toBe("none");
	});
});

describe("schema repair — strict unknown-key mode (U4-01)", () => {
	it("refuses an unrecognized key on a schema with additionalProperties: false", () => {
		const reason = detectStrictUnknownKeyRepair(strictTool.parameters as Record<string, unknown>, {
			path: "/tmp/a.txt",
			bogus: "nope",
		});
		expect(reason).toBeDefined();
		expect(reason?.reason).toContain("bogus");
		expect(reason?.reason).toContain("not allowed");

		const outcome = call({ path: "/tmp/a.txt", bogus: "nope" }, strictTool);
		expect(outcome.status).toBe("unrepairable");
		if (outcome.status !== "unrepairable") return;
		expect(outcome.reason).toContain("bogus");
	});

	it("passes a fully-declared call through a strict schema unchanged", () => {
		const outcome = call({ path: "/tmp/a.txt", content: "hello" }, strictTool);
		expect(outcome.status).toBe("clean");
		if (outcome.status !== "clean") return;
		expect(outcome.arguments).toEqual({ path: "/tmp/a.txt", content: "hello" });
	});

	it("resolves an alias key before enforcing strict unknown-key rejection", () => {
		// filepath aliases cleanly to path, so it must never reach the
		// strict-mode refusal — the cascade order (alias rename, then strict
		// check) is itself the contract under test.
		const outcome = call({ filepath: "/tmp/a.txt" }, strictTool);
		expect(outcome.status).toBe("repaired");
		if (outcome.status !== "repaired") return;
		expect(outcome.arguments).toEqual({ path: "/tmp/a.txt" });
	});

	it("still refuses a genuinely unrecognized key under strict mode even after alias resolution", () => {
		const outcome = call({ filepath: "/tmp/a.txt", bogus: "nope" }, strictTool);
		expect(outcome.status).toBe("unrepairable");
		if (outcome.status !== "unrepairable") return;
		expect(outcome.reason).toContain("bogus");
		expect(outcome.reason).not.toContain("filepath");
	});

	it("non-strict schemas (additionalProperties absent) never trigger strict rejection", () => {
		const reason = detectStrictUnknownKeyRepair(sampleTool.parameters as Record<string, unknown>, {
			path: "/tmp/a.txt",
			bogus: "nope",
		});
		expect(reason).toBeUndefined();
	});

	it("never applies strict unknown-key rejection to a real ArkType-authored tool (regression)", () => {
		// ArkType/Zod wire conversion (`closeDeclaredObjects`) synthesizes
		// `additionalProperties: false` on every declared object node to match
		// the provider-facing "closed" emission convention — it is NOT an
		// authorial strictness opt-in. Mirrors a real shipped tool shape
		// (e.g. `write.ts`'s `{ path, content }`) through the actual
		// `toolWireSchema()` pipeline the runtime uses, so this must fail if
		// the gate in `repairToolCallArguments` is removed or weakened.
		const arkTool: Tool = {
			name: "write",
			description: "write a file",
			parameters: type({ path: "string", content: "string" }),
		};
		expect(toolWireSchema(arkTool).additionalProperties).toBe(false);

		const outcome = call({ path: "/tmp/a.txt", content: "hello", hallucinatedExtra: "model-noise" }, arkTool);
		expect(outcome.status).not.toBe("unrepairable");
		if (outcome.status === "unrepairable") return;
		expect(outcome.arguments).toMatchObject({ path: "/tmp/a.txt", content: "hello" });
	});
});
