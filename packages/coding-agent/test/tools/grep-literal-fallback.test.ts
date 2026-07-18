import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { createTools, type ToolSession } from "@veyyon/coding-agent/tools";
import { removeWithRetries } from "@veyyon/utils";

function createTestSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

// A pattern that neither the Rust regex engine nor PCRE2 will compile, so native
// grep demotes it to a literal search. The tool must say so loudly rather than
// let the demotion pass silently (Law 10: no silent fallback — a literal search
// of a regex the caller wrote hides the recall loss).
describe("grep literal-fallback notice (Law 10)", () => {
	let tempDir: string;

	beforeAll(async () => {
		await initTheme(false, undefined, undefined, "dark", "light");
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-literal-fallback-"));
		await fs.writeFile(path.join(tempDir, "hay.txt"), "before\nx foo[bar y\nafter\n");
	});

	afterAll(async () => {
		await removeWithRetries(tempDir);
		resetSettingsForTest();
	});

	it("surfaces a loud notice when an uncompilable pattern is demoted to a literal search", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "grep");
		if (!tool) throw new Error("Missing grep tool");

		const result = await tool.execute("grep-literal-fallback", {
			pattern: "foo[bar",
			path: ".",
		});
		const text = getText(result);

		// Recall is preserved: the literal text is still found.
		expect(text).toContain("foo[bar");
		// ...but the demotion is announced, not silent.
		expect(text).toMatch(/did not compile as a regex/i);
		expect(text).toMatch(/searched for it literally/i);
	});

	it("adds no notice for a pattern that compiles as a regex", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "grep");
		if (!tool) throw new Error("Missing grep tool");

		// `foo.bar` is a valid regex; `.` matches the literal `[`, so it still
		// hits the same line — but nothing was demoted, so no notice appears.
		const result = await tool.execute("grep-valid-regex", {
			pattern: "foo.bar",
			path: ".",
		});
		const text = getText(result);

		expect(text).toContain("foo[bar");
		expect(text).not.toMatch(/did not compile as a regex/i);
	});
});
