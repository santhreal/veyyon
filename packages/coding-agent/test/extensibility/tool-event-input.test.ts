import { describe, expect, it } from "bun:test";
import { normalizeToolEventInput, resolveToolEventInput } from "@veyyon/coding-agent/extensibility/tool-event-input";

describe("resolveToolEventInput", () => {
	const upper = { name: "edit", resolveEventInput: (input: string) => input.toUpperCase() };

	it("resolves input and _input through the tool resolver without mutating the original", () => {
		const input = { input: "abc", _input: "def", other: 1 };
		const resolved = resolveToolEventInput(upper, input);
		expect(resolved).toEqual({ input: "ABC", _input: "DEF", other: 1 });
		expect(input.input).toBe("abc");
		expect(resolved).not.toBe(input);
	});

	it("returns the same object when the resolver changes nothing", () => {
		const input = { input: "ABC" };
		expect(resolveToolEventInput(upper, input)).toBe(input);
	});

	it("passes through non-edit tools and tools without a resolver", () => {
		const input = { input: "abc" };
		expect(resolveToolEventInput({ name: "bash", resolveEventInput: s => s.toUpperCase() }, input)).toBe(input);
		expect(resolveToolEventInput({ name: "edit" }, input)).toBe(input);
	});

	it("skips blank and non-string input fields", () => {
		const input = { input: "   ", _input: 42 };
		expect(resolveToolEventInput(upper, input)).toBe(input);
	});
});

describe("normalizeToolEventInput", () => {
	it("passes through non-edit tools and edits that already carry a path", () => {
		const bash = { command: "ls" };
		expect(normalizeToolEventInput("bash", bash)).toBe(bash);
		const edit = { path: "src/a.ts", input: "¶src/b.ts#abcd" };
		expect(normalizeToolEventInput("edit", edit)).toBe(edit);
	});

	it("derives the path from a single hashline header, ignoring a model-supplied _path", () => {
		const input = { input: "¶src/real.ts#abcd\nsome edit body", _path: "/etc/passwd" };
		const normalized = normalizeToolEventInput("edit", input);
		expect(normalized.path).toBe("src/real.ts");
		expect(normalized.paths).toEqual(["src/real.ts"]);
	});

	it("emits only paths (no single path) for multi-file hashline edits", () => {
		const input = { input: "¶a.ts#0001\nx\n¶b.ts#0002\ny" };
		const normalized = normalizeToolEventInput("edit", input);
		expect(normalized.path).toBeUndefined();
		expect(normalized.paths).toEqual(["a.ts", "b.ts"]);
	});

	it("strips quotes and #TAG suffixes from hashline header paths", () => {
		const normalized = normalizeToolEventInput("edit", { input: '¶"my file.ts"#ABCD\nbody' });
		expect(normalized.path).toBe("my file.ts");
	});

	it("propagates _path to path for replace/patch edits without hashline input", () => {
		const normalized = normalizeToolEventInput("edit", { _path: "src/a.ts", oldText: "x", newText: "y" });
		expect(normalized.path).toBe("src/a.ts");
	});

	it("returns the input unchanged when there is nothing to derive", () => {
		const input = { input: "no headers here" };
		expect(normalizeToolEventInput("edit", input)).toBe(input);
		const empty = {};
		expect(normalizeToolEventInput("edit", empty)).toBe(empty);
	});
});
