import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { GrepTool } from "@veyyon/coding-agent/tools/grep";
import { removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

/**
 * Grep multi-file, unicode, and word-boundary-ish exact match contracts.
 */

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

describe("GrepTool multiline and unicode adversarial", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-ml-"));
		await Bun.write(path.join(tmpDir, "u.ts"), "const 名前 = 1;\nconst name = 2;\n");
		await Bun.write(path.join(tmpDir, "dup.ts"), "alpha\nalpha\nbeta\nalpha\n");
		await fs.mkdir(path.join(tmpDir, "nested"), { recursive: true });
		await Bun.write(path.join(tmpDir, "nested", "deep.ts"), "deep-token-zzz\n");
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
			getArtifactsDir: () => path.join(tmpDir, "artifacts"),
			settings: Settings.isolated({ "grep.enabled": true }),
		});
	}

	it("matches unicode identifier", async () => {
		const tool = new GrepTool(session() as never);
		const text = textOf(await tool.execute("g1", { pattern: "名前", path: path.join(tmpDir, "u.ts") }));
		expect(text).toContain("名前");
		expect(text.includes("const name = 2") && !text.includes("名前")).toBe(false);
	});

	it("finds deep-token under nested path when searching the tree", async () => {
		const tool = new GrepTool(session() as never);
		const text = textOf(await tool.execute("g2", { pattern: "deep-token-zzz", path: tmpDir }));
		expect(text).toContain("deep-token-zzz");
	});

	it("reports multiple alpha lines from dup.ts", async () => {
		const tool = new GrepTool(session() as never);
		const text = textOf(await tool.execute("g3", { pattern: "alpha", path: path.join(tmpDir, "dup.ts") }));
		const alphaHits = text.split("\n").filter(l => l.includes("alpha")).length;
		expect(alphaHits).toBeGreaterThanOrEqual(3);
	});

	it("regex alternation matches either branch", async () => {
		const tool = new GrepTool(session() as never);
		const text = textOf(await tool.execute("g4", { pattern: "alpha|beta", path: path.join(tmpDir, "dup.ts") }));
		expect(text).toContain("alpha");
		expect(text).toContain("beta");
	});

	it("does not match across files when path is a single file", async () => {
		const tool = new GrepTool(session() as never);
		const text = textOf(
			await tool.execute("g5", {
				pattern: "deep-token-zzz",
				path: path.join(tmpDir, "dup.ts"),
			}),
		);
		expect(text.includes("deep-token-zzz")).toBe(false);
	});
});
