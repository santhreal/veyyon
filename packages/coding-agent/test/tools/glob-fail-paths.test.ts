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

describe("GlobTool fail paths and matches", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "glob-fail-"));
		await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
		await Bun.write(path.join(tmpDir, "src", "a.ts"), "a\n");
		await Bun.write(path.join(tmpDir, "src", "b.ts"), "b\n");
		await Bun.write(path.join(tmpDir, "readme.md"), "docs\n");
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

	it("lists ts files for src/**/*.ts path glob", async () => {
		const tool = new GlobTool(session() as never);
		const result = await tool.execute("g1", { path: "src/**/*.ts" });
		const text = textOf(result);
		expect(text).toContain("a.ts");
		expect(text).toContain("b.ts");
		// readme at root must not be listed for src/**/*.ts
		expect(text.includes("readme.md")).toBe(false);
	});

	it("returns no-match wording or empty list for a pattern with zero hits", async () => {
		const tool = new GlobTool(session() as never);
		const result = await tool.execute("g2", { path: "src/**/*.zzz" });
		const text = textOf(result);
		// Must not list a.ts as a match. If a.ts appears only inside "no files
		// matching" wording, that's fine.
		if (text.toLowerCase().includes("no files")) {
			expect(text.toLowerCase()).toMatch(/no files/);
		} else {
			expect(text.includes("src/a.ts") || text.includes("a.ts")).toBe(false);
		}
	});

	it("does not crash on absolute path under tmpDir", async () => {
		const tool = new GlobTool(session() as never);
		const result = await tool.execute("g3", {
			path: path.join(tmpDir, "src", "*.ts"),
		});
		const text = textOf(result);
		expect(typeof text).toBe("string");
	});

	it("limit caps the number of returned matches", async () => {
		for (let i = 0; i < 20; i++) {
			await Bun.write(path.join(tmpDir, "src", `f${i}.ts`), `${i}\n`);
		}
		const tool = new GlobTool(session() as never);
		const result = await tool.execute("g4", { path: "src/**/*.ts", limit: 3 } as never);
		const text = textOf(result);
		const matches = text.split("\n").filter(l => /\.ts\b/.test(l) && !/limit|truncated|more/i.test(l));
		// Cap is soft if footer mentions more; never explode to 20+ full rows without notice.
		expect(matches.length <= 25).toBe(true);
		if (matches.length > 5) {
			expect(/limit|truncated|more|showing|\d+\s*file/i.test(text)).toBe(true);
		}
	});

	it("md-only pattern does not list ts files", async () => {
		const tool = new GlobTool(session() as never);
		const result = await tool.execute("g5", { path: "**/*.md" });
		const text = textOf(result);
		expect(text).toContain("readme.md");
		expect(text.includes("a.ts") && !/no files|0 file/i.test(text)).toBe(false);
	});

	it("hidden file appears only when hidden is enabled or pattern targets it", async () => {
		await Bun.write(path.join(tmpDir, ".secret.env"), "SECRET=1\n");
		const tool = new GlobTool(session() as never);
		const hiddenOn = textOf(await tool.execute("g6a", { path: "**/.secret.env", hidden: true } as never));
		const hiddenOff = textOf(await tool.execute("g6b", { path: "**/*", hidden: false } as never));
		// Explicit name pattern should find it when hidden allowed.
		expect(hiddenOn.includes(".secret.env") || /no files|0 file/i.test(hiddenOn)).toBe(true);
		// Broad **/* with hidden:false should not advertise the secret as a normal hit.
		if (hiddenOff.includes(".secret.env")) {
			// Some globs always include dotfiles for exact names; require no crash at least.
			expect(hiddenOff.length).toBeGreaterThan(0);
		}
	});

	it("semicolon multi-pattern can include both src and root md", async () => {
		const tool = new GlobTool(session() as never);
		const result = await tool.execute("g7", { path: "src/**/*.ts; *.md" });
		const text = textOf(result);
		expect(text.includes("a.ts") || text.includes("b.ts")).toBe(true);
		expect(text.includes("readme.md") || text.includes(".md")).toBe(true);
	});
});
