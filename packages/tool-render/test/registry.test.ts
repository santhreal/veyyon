import { describe, expect, it } from "bun:test";
import { resolveToolRenderer } from "../src/registry";
import { stripAnsi } from "../src/util";

describe("@veyyon/tool-render registry", () => {
	it("resolves known tools and falls back to generic for unknown names", () => {
		const bash = resolveToolRenderer("bash");
		const unknown = resolveToolRenderer("definitely-not-a-real-tool-xyz");
		expect(bash.Summary).toBeDefined();
		expect(unknown.Summary).toBeDefined();
		expect(bash).not.toBe(unknown);
	});

	it("keeps stripAnsi browser-safe (no Node deps in the util path)", () => {
		expect(stripAnsi("plain\x1b[31mred\x1b[0m")).toBe("plainred");
	});
});
