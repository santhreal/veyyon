/**
 * Tool arguments that cannot be used must not vanish as though the call had none.
 *
 * WHY THIS SUITE EXISTS. Three streaming dialects (DeepSeek, Harmony, Kimi) each parsed a tool call's
 * raw `arguments` text with their own private copy of the same four lines, and each copy caught the
 * parse failure and returned `{}`. Empty is also what a call that genuinely takes no arguments produces,
 * so a model whose arguments the repair pass could not salvage had them DROPPED IN SILENCE: the tool ran
 * with no arguments, which is a different call from the one the model made, and nothing said so. A
 * truncated `{"a":1` is not exotic either, it is what a stream cut mid-arguments looks like.
 *
 * There is one owner now, `parseToolArgsText`, shared with the GitLab Duo provider's MCP arguments (a
 * fourth copy of the same four lines), and it reports two distinct losses that used to look identical to
 * a caller. Text that will not parse at all is one. Text that parses into something that is
 * NOT an object (a bare string, an array) is the other, which `recordOrEmpty` used to flatten to `{}` on
 * its own; that route is separate because it reaches the same wrong outcome without any error being
 * thrown, so a fix that only handled the throw would have left half the loss silent.
 *
 * Empty is still returned. A dialect parser cannot abort a stream mid-tool-call, and refusing the call
 * belongs to the tool's own argument validation, so the report is the entire fix and the report is what
 * is asserted here.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { logger } from "@veyyon/utils";
import { parseToolArgsText } from "../src/dialect/coercion";

/** Captured `logger.warn` calls: the message and its structured fields. */
type Warning = { message: string; meta: Record<string, unknown> };

/** Run the parser with `logger.warn` captured, so the report can be asserted rather than the log inspected. */
function parseWithWarnings(
	raw: string,
	context: { source: string; tool?: string },
): { args: Record<string, unknown>; warnings: Warning[] } {
	const warnings: Warning[] = [];
	const spy = spyOn(logger, "warn").mockImplementation(((message: string, meta?: Record<string, unknown>) => {
		warnings.push({ message, meta: meta ?? {} });
	}) as never);
	try {
		return { args: parseToolArgsText(raw, context), warnings };
	} finally {
		spy.mockRestore();
	}
}

describe("arguments that parse into an object", () => {
	/** The ordinary case: the object comes through unchanged and nothing is reported. */
	it("returns them unchanged and warns about nothing", () => {
		const { args, warnings } = parseWithWarnings('{"path":"src/main.ts","limit":40}', { source: "deepseek" });

		expect(args).toEqual({ path: "src/main.ts", limit: 40 });
		expect(warnings).toEqual([]);
	});

	/** The repair pass exists to salvage the near-misses models emit; a salvaged object is not a loss. */
	it("accepts what the repair pass can salvage, quietly", () => {
		const { args, warnings } = parseWithWarnings('{"path": "src/main.ts",}', { source: "kimi" });

		expect(args).toEqual({ path: "src/main.ts" });
		expect(warnings).toEqual([]);
	});

	/** An empty object is a real answer, distinct from every failure below, and stays silent. */
	it("accepts an explicitly empty object", () => {
		const { args, warnings } = parseWithWarnings("{}", { source: "harmony" });

		expect(args).toEqual({});
		expect(warnings).toEqual([]);
	});
});

describe("a call that genuinely has no arguments", () => {
	/**
	 * This is the case the failures used to be confused with, so it has to stay silent: an empty string
	 * means the model called the tool with nothing, which is legitimate for a tool that takes nothing.
	 */
	it("returns an empty record without warning", () => {
		expect(parseWithWarnings("", { source: "deepseek" })).toEqual({ args: {}, warnings: [] });
		expect(parseWithWarnings("   \n\t ", { source: "deepseek" })).toEqual({ args: {}, warnings: [] });
	});
});

describe("arguments that will not parse", () => {
	/**
	 * The regression this exists to prevent, in the shape it actually arrives in: a stream cut partway
	 * through the JSON. The tool still gets an empty record, and the report names the source, the tool,
	 * and the text, which is the only way to tell this apart from a no-argument call after the fact.
	 */
	it("reports a truncated object with the source, the tool and the text", () => {
		const { args, warnings } = parseWithWarnings('{"path":"src/main.ts"', { source: "deepseek", tool: "read" });

		expect(args).toEqual({});
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toBe("Tool call arguments could not be parsed; the tool is being called with none");
		expect(warnings[0]?.meta.source).toBe("deepseek");
		expect(warnings[0]?.meta.tool).toBe("read");
		expect(warnings[0]?.meta.excerpt).toBe('{"path":"src/main.ts"');
		expect(typeof warnings[0]?.meta.error).toBe("string");
		expect(warnings[0]?.meta.error).not.toBe("");
	});

	/**
	 * Several distinct ways the text can be unusable, each of which produced the same silent `{}`. Listed
	 * individually because they throw different messages, and a fix that special-cased one shape would
	 * otherwise pass while still swallowing the rest.
	 */
	it.each([
		['{"a":', "a value missing after the colon"],
		["not json at all", "prose where JSON was expected"],
		["{{{{", "nested openings with no keys"],
		['{"a":1}}}}}', "trailing characters after a complete object"],
		["<tool>x</tool>", "markup instead of arguments"],
	])("reports %p (%s)", (raw, _shape) => {
		const { args, warnings } = parseWithWarnings(raw, { source: "kimi", tool: "grep" });

		expect(args).toEqual({});
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.meta.tool).toBe("grep");
	});

	/** A long payload is excerpted rather than logged whole, and the excerpt says it was cut. */
	it("excerpts a long payload instead of logging all of it", () => {
		const long = `{"body":"${"x".repeat(5000)}`;

		const { warnings } = parseWithWarnings(long, { source: "harmony", tool: "write" });

		const excerpt = String(warnings[0]?.meta.excerpt);
		expect(excerpt.length).toBeLessThan(220);
		expect(excerpt.endsWith("…")).toBe(true);
		expect(excerpt.startsWith('{"body":"xxx')).toBe(true);
	});
});

describe("arguments that parse into something that is not an object", () => {
	/**
	 * The second route to the same loss, and the reason this is not just a `try`/`catch` fix. Nothing
	 * throws here: the JSON is valid, `recordOrEmpty` flattened a non-record to `{}`, and the tool ran
	 * with no arguments. The report says what actually arrived so the dialect can be corrected.
	 */
	it("reports a bare string", () => {
		const { args, warnings } = parseWithWarnings('"src/main.ts"', { source: "deepseek", tool: "read" });

		expect(args).toEqual({});
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toBe("Tool call arguments were not an object; the tool is being called with none");
		expect(warnings[0]?.meta.received).toBe("string");
		expect(warnings[0]?.meta.excerpt).toBe('"src/main.ts"');
	});

	/** An array is the other shape models reach for, and it must be named as an array, not as "object". */
	it("reports an array as an array", () => {
		const { args, warnings } = parseWithWarnings('["src/main.ts", 40]', { source: "kimi", tool: "read" });

		expect(args).toEqual({});
		expect(warnings[0]?.meta.received).toBe("array");
	});

	/** A number and a boolean are reported too, so the check is on being a record rather than a list of shapes. */
	it.each([
		["42", "number"],
		["true", "boolean"],
	])("reports %p as %s", (raw, received) => {
		const { args, warnings } = parseWithWarnings(raw, { source: "harmony" });

		expect(args).toEqual({});
		expect(warnings[0]?.meta.received).toBe(received);
	});

	/**
	 * `null` is valid JSON and not a record, so it must be reported rather than passing as "no arguments":
	 * a model emitting `null` for arguments is a dialect problem worth seeing, and `typeof null` being
	 * "object" is exactly the trap that would let it through unnoticed.
	 */
	it("reports null", () => {
		const { args, warnings } = parseWithWarnings("null", { source: "deepseek", tool: "bash" });

		expect(args).toEqual({});
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toContain("were not an object");
	});
});
