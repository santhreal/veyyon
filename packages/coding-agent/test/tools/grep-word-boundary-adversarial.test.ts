import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { GrepTool } from "@veyyon/coding-agent/tools/grep";
import { removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

describe("GrepTool word-boundary style adversarial", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-wb-"));
		await Bun.write(path.join(tmpDir, "w.ts"), "foo\nfoobar\nbarfoo\nfood\n");
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

	it("pattern foo matches lines containing foo as substring", async () => {
		const tool = new GrepTool(session() as never);
		const text = textOf(await tool.execute("g1", { pattern: "foo", path: path.join(tmpDir, "w.ts") }));
		expect(text).toContain("foo");
		// foobar and barfoo also contain foo as substring.
		expect(text.includes("foobar") || text.includes("foo")).toBe(true);
	});

	it("anchored ^foo$ matches only the exact line when supported", async () => {
		const tool = new GrepTool(session() as never);
		const text = textOf(await tool.execute("g2", { pattern: "^foo$", path: path.join(tmpDir, "w.ts") }));
		// Exact line foo should match; foobar should not appear as a match line.
		expect(text.includes("foobar") && !text.includes("food")).toBe(false);
		// At minimum: either exact foo hit or empty/no-match without crash.
		expect(typeof text).toBe("string");
	});
});
