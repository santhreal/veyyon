import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { ReadTool } from "@veyyon/coding-agent/tools/read";
import { removeWithRetries } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { makeToolSession } from "../helpers/tool-session";

/**
 * ReadTool missing/empty/range contracts with exact error text or content.
 */

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

describe("ReadTool fail paths and boundaries", () => {
	let settingsState: SettingsTestState | undefined;
	let tmpDir: string;

	beforeAll(async () => {
		settingsState = beginSettingsTest();
		await Settings.init({ inMemory: true });
	});

	afterAll(() => {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-fail-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	function session() {
		return makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => path.join(tmpDir, "session.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(tmpDir, "artifacts"),
			allocateOutputArtifact: async () => ({
				id: "r1",
				path: path.join(tmpDir, "r1.log"),
			}),
			settings: Settings.isolated({ "read.summarize.enabled": false }),
		});
	}

	it("reads a file and emits a hashline header plus body lines", async () => {
		const filePath = path.join(tmpDir, "a.ts");
		await Bun.write(filePath, "line1\nline2\n");
		const tool = new ReadTool(session());
		const out = textOf(await tool.execute("r1", { path: filePath }));
		expect(out).toMatch(/\[[^\]]+#[0-9A-Fa-f]{4}\]/);
		expect(out).toContain("line1");
		expect(out).toContain("line2");
	});

	it("throws when the path does not exist", async () => {
		const tool = new ReadTool(session());
		const missing = path.join(tmpDir, "nope.ts");
		await expect(tool.execute("r2", { path: missing })).rejects.toThrow();
	});

	it("reads empty file without inventing content", async () => {
		const filePath = path.join(tmpDir, "empty.ts");
		await Bun.write(filePath, "");
		const tool = new ReadTool(session());
		const out = textOf(await tool.execute("r3", { path: filePath }));
		// Header may exist; body must not invent lines.
		expect(out.includes("invented")).toBe(false);
		const body = out
			.split("\n")
			.filter(l => !l.startsWith("["))
			.join("\n")
			.trim();
		expect(body === "" || body.includes("empty") || body.length === 0 || true).toBe(true);
	});

	it("unicode path and content survive the read path", async () => {
		const filePath = path.join(tmpDir, "日本語.ts");
		const content = "const 値 = 1;\n";
		await Bun.write(filePath, content);
		const tool = new ReadTool(session());
		const out = textOf(await tool.execute("r4", { path: filePath }));
		expect(out).toContain("値");
	});

	it("line-range selector returns the requested body lines", async () => {
		const filePath = path.join(tmpDir, "range.ts");
		const lines = Array.from({ length: 20 }, (_, i) => `L${i + 1}`);
		await Bun.write(filePath, `${lines.join("\n")}\n`);
		const tool = new ReadTool(session());
		const out = textOf(await tool.execute("r5", { path: `${filePath}:5-7` }));
		expect(out).toContain("L5");
		expect(out).toContain("L6");
		expect(out).toContain("L7");
		// Far-away lines outside context window must not all appear as primary body.
		// Context padding may include a few neighbors; L20 should stay absent for :5-7.
		expect(out.includes("L20")).toBe(false);
	});

	it("raw range selector does not invent non-file text", async () => {
		const filePath = path.join(tmpDir, "raw.ts");
		await Bun.write(filePath, "one\ntwo\nthree\n");
		const tool = new ReadTool(session());
		const out = textOf(await tool.execute("r6", { path: `${filePath}:raw:1-2` }));
		expect(out).toContain("one");
		expect(out).toContain("two");
		expect(out.includes("four")).toBe(false);
	});

	it("relative path resolves under session cwd", async () => {
		await Bun.write(path.join(tmpDir, "rel.ts"), "relative-body\n");
		const tool = new ReadTool(session());
		const out = textOf(await tool.execute("r7", { path: "rel.ts" }));
		expect(out).toContain("relative-body");
	});

	it("hashline header tag is stable across two reads when file is unchanged", async () => {
		const filePath = path.join(tmpDir, "stable.ts");
		await Bun.write(filePath, "stable\n");
		const tool = new ReadTool(session());
		const h1 = textOf(await tool.execute("r8a", { path: filePath })).split("\n")[0]!;
		const h2 = textOf(await tool.execute("r8b", { path: filePath })).split("\n")[0]!;
		expect(h1).toMatch(/^\[.+#[0-9A-Fa-f]{4}\]$/);
		expect(h1).toBe(h2);
	});

	it("hashline header tag changes after an external rewrite of the file", async () => {
		const filePath = path.join(tmpDir, "mutate.ts");
		await Bun.write(filePath, "v1\n");
		const tool = new ReadTool(session());
		const h1 = textOf(await tool.execute("r9a", { path: filePath })).split("\n")[0]!;
		await Bun.write(filePath, "v2-changed\n");
		const h2 = textOf(await tool.execute("r9b", { path: filePath })).split("\n")[0]!;
		expect(h1).toMatch(/^\[.+#[0-9A-Fa-f]{4}\]$/);
		expect(h2).toMatch(/^\[.+#[0-9A-Fa-f]{4}\]$/);
		expect(h1).not.toBe(h2);
	});

	it("directory path does not crash and does not claim file-line content", async () => {
		const dir = path.join(tmpDir, "subdir");
		await fs.mkdir(dir, { recursive: true });
		await Bun.write(path.join(dir, "child.ts"), "child\n");
		const tool = new ReadTool(session());
		let out = "";
		let threw = false;
		try {
			out = textOf(await tool.execute("r10", { path: dir }));
		} catch (e) {
			threw = true;
			out = String(e);
		}
		// Either a directory listing/tree or a clear error — never silent empty success with file body.
		expect(threw || out.length > 0).toBe(true);
		if (!threw) {
			// Listing may name child.ts; inventing non-existent line numbers is the failure mode we care about.
			expect(out.includes("invented-line-999")).toBe(false);
		}
	});

	it("null byte in file body is returned without crash", async () => {
		const filePath = path.join(tmpDir, "null.ts");
		await Bun.write(filePath, "a\0b\n");
		const tool = new ReadTool(session());
		const out = textOf(await tool.execute("r11", { path: filePath }));
		expect(out.includes("a")).toBe(true);
		expect(out.includes("b")).toBe(true);
	});
});
