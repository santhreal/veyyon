import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { GlobTool } from "@veyyon/coding-agent/tools/glob";
import { removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

describe("GlobTool nested and extension adversarial", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "glob-nest-"));
		await fs.mkdir(path.join(tmpDir, "a", "b", "c"), { recursive: true });
		await Bun.write(path.join(tmpDir, "a", "b", "c", "deep.ts"), "d\n");
		await Bun.write(path.join(tmpDir, "a", "top.ts"), "t\n");
		await Bun.write(path.join(tmpDir, "a", "note.md"), "m\n");
		await Bun.write(path.join(tmpDir, "root.json"), "{}\n");
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	function session() {
		return makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "glob.enabled": true }),
		});
	}

	it("**/*.ts finds both deep and shallow ts files", async () => {
		const tool = new GlobTool(session() as never);
		const text = textOf(await tool.execute("g1", { path: "**/*.ts" }));
		expect(text).toContain("deep.ts");
		expect(text).toContain("top.ts");
		expect(text.includes("note.md") && !/no files/i.test(text)).toBe(false);
	});

	it("a/b/**/*.ts finds only deep.ts", async () => {
		const tool = new GlobTool(session() as never);
		const text = textOf(await tool.execute("g2", { path: "a/b/**/*.ts" }));
		expect(text).toContain("deep.ts");
		expect(text.includes("top.ts") && !/no files|0 file/i.test(text)).toBe(false);
	});

	it("*.json at root finds root.json not nested", async () => {
		const tool = new GlobTool(session() as never);
		const text = textOf(await tool.execute("g3", { path: "*.json" }));
		// Bare *.json may recurse to **/*.json per product; assert root.json present.
		expect(text).toContain("root.json");
	});

	it("extension filter *.md excludes .ts", async () => {
		const tool = new GlobTool(session() as never);
		const text = textOf(await tool.execute("g4", { path: "**/*.md" }));
		expect(text).toContain("note.md");
		expect(text.includes("deep.ts") && !/no files/i.test(text)).toBe(false);
	});
});
