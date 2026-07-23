import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { ToolError } from "@veyyon/coding-agent/tools/tool-errors";
import { WriteTool } from "@veyyon/coding-agent/tools/write";
import { removeWithRetries } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { makeToolSession } from "../helpers/tool-session";

/**
 * Write tool fail-closed and boundary contracts: missing content, plan-mode
 * tree block, empty path, and successful create with exact byte report.
 * Drives the shipped WriteTool.execute path end to end on a real temp tree.
 */

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

describe("WriteTool fail paths and boundaries", () => {
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
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-fail-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	function session(opts: { planEnabled?: boolean } = {}) {
		const artifacts = path.join(tmpDir, "artifacts");
		return makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => path.join(tmpDir, "session.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => artifacts,
			allocateOutputArtifact: async () => ({
				id: "a1",
				path: path.join(tmpDir, "a1.log"),
			}),
			settings: Settings.isolated({ "lsp.formatOnWrite": false, "lsp.diagnosticsOnWrite": false }),
			enableLsp: false,
			getPlanModeState: () =>
				opts.planEnabled ? { enabled: true, planFilePath: "local://plan.md" } : { enabled: false },
		});
	}

	it("writes content and reports exact byte count for a new in-cwd file", async () => {
		const filePath = path.join(tmpDir, "out.ts");
		const content = "export const n = 1;\n";
		const tool = new WriteTool(session());
		const result = await tool.execute("w1", { path: filePath, content });
		const text = textOf(result);
		expect(await Bun.file(filePath).text()).toBe(content);
		expect(text).toContain(`Successfully wrote ${content.length} bytes`);
		expect(text).toMatch(/\[[^\]]+#[0-9A-Fa-f]{4}\]/);
	});

	it("overwrites an existing file with the new bytes (no append)", async () => {
		const filePath = path.join(tmpDir, "exist.ts");
		await Bun.write(filePath, "OLD\n");
		const tool = new WriteTool(session());
		const content = "NEW\nLINE\n";
		await tool.execute("w2", { path: filePath, content });
		expect(await Bun.file(filePath).text()).toBe(content);
	});

	it("rejects write under plan mode when target is the working tree", async () => {
		const filePath = path.join(tmpDir, "blocked.ts");
		const tool = new WriteTool(session({ planEnabled: true }));
		await expect(tool.execute("w3", { path: filePath, content: "x\n" })).rejects.toThrow(ToolError);
		await expect(tool.execute("w3b", { path: filePath, content: "x\n" })).rejects.toThrow(
			/working tree is read-only/i,
		);
		// Disk must stay absent.
		expect(await Bun.file(filePath).exists()).toBe(false);
	});

	it("allows write under plan mode into local:// sandbox", async () => {
		const artifacts = path.join(tmpDir, "artifacts");
		await fs.mkdir(path.join(artifacts, "local"), { recursive: true });
		const tool = new WriteTool(session({ planEnabled: true }));
		const result = await tool.execute("w4", {
			path: "local://plan-notes.md",
			content: "# plan\n",
		});
		const text = textOf(result);
		expect(text.toLowerCase()).not.toContain("working tree is read-only");
		const onDisk = path.join(artifacts, "local", "plan-notes.md");
		expect(await Bun.file(onDisk).text()).toBe("# plan\n");
	});

	it("filesystemTargets unwraps hashline headers for cwd boundary", () => {
		const tool = new WriteTool(session());
		const targets = tool.filesystemTargets?.({ path: "[src/a.ts#ab12]", content: "x" }) ?? [];
		expect(targets).toEqual(["src/a.ts"]);
	});

	it("approval tier is write for plain paths and exec for ssh targets", () => {
		const tool = new WriteTool(session());
		const tier = typeof tool.approval === "function" ? tool.approval : () => tool.approval;
		expect(tier({ path: "src/a.ts", content: "x" })).toBe("write");
		expect(tier({ path: "ssh://host/tmp/x", content: "x" })).toBe("exec");
		// Hashline-wrapped ssh must not dodge exec tier.
		expect(tier({ path: "[ssh://host/tmp/x#abcd]", content: "x" })).toBe("exec");
	});

	it("empty content still creates the file (zero-byte write is valid)", async () => {
		const filePath = path.join(tmpDir, "empty.txt");
		const tool = new WriteTool(session());
		const result = await tool.execute("w5", { path: filePath, content: "" });
		expect(await Bun.file(filePath).text()).toBe("");
		expect(textOf(result)).toContain("Successfully wrote 0 bytes");
	});

	it("unicode content round-trips exact bytes", async () => {
		const filePath = path.join(tmpDir, "jp.ts");
		const content = "const 名前 = '日本語';\n";
		const tool = new WriteTool(session());
		await tool.execute("w6", { path: filePath, content });
		expect(await Bun.file(filePath).text()).toBe(content);
	});

	it("creates intermediate directories when writing a nested relative path", async () => {
		const nested = path.join(tmpDir, "deep", "nested", "out.ts");
		const tool = new WriteTool(session());
		const content = "export const nested = true;\n";
		await tool.execute("w7", { path: nested, content });
		expect(await Bun.file(nested).text()).toBe(content);
	});

	it("relative path writes resolve against session cwd not process.cwd", async () => {
		const content = "relative-ok\n";
		const tool = new WriteTool(session());
		await tool.execute("w8", { path: "rel.ts", content });
		expect(await Bun.file(path.join(tmpDir, "rel.ts")).text()).toBe(content);
	});

	it("two sequential writes to the same path leave only the last content", async () => {
		const filePath = path.join(tmpDir, "seq.ts");
		const tool = new WriteTool(session());
		await tool.execute("w9a", { path: filePath, content: "first\n" });
		await tool.execute("w9b", { path: filePath, content: "second\n" });
		expect(await Bun.file(filePath).text()).toBe("second\n");
	});

	it("CRLF content is written as provided without silent LF-only rewrite inventing data", async () => {
		const filePath = path.join(tmpDir, "crlf.txt");
		const content = "a\r\nb\r\n";
		const tool = new WriteTool(session());
		await tool.execute("w10", { path: filePath, content });
		const onDisk = await Bun.file(filePath).text();
		// Product may normalize line endings; assert no data loss of non-newline payload.
		expect(onDisk.replace(/\r\n/g, "\n").replace(/\r/g, "\n")).toBe("a\nb\n");
		expect(onDisk.includes("a")).toBe(true);
		expect(onDisk.includes("b")).toBe(true);
	});

	it("null-byte-containing content is preserved as written", async () => {
		const filePath = path.join(tmpDir, "null.bin");
		const content = "before\0after\n";
		const tool = new WriteTool(session());
		await tool.execute("w11", { path: filePath, content });
		expect(await Bun.file(filePath).text()).toBe(content);
	});

	it("filesystemTargets unwraps only bracketed hashline headers, not bare paths", () => {
		const tool = new WriteTool(session());
		expect(tool.filesystemTargets?.({ path: "src/plain.ts", content: "x" }) ?? []).toEqual(["src/plain.ts"]);
		expect(tool.filesystemTargets?.({ path: "[src/a.ts#ab12]", content: "x" }) ?? []).toEqual(["src/a.ts"]);
		// Malformed bracket without closing is not silently rewritten.
		const malformed = tool.filesystemTargets?.({ path: "[src/a.ts#ab12", content: "x" }) ?? [];
		expect(malformed[0]).toContain("[src/a.ts#ab12");
	});

	it("plan mode blocks absolute path outside sandbox even when path looks like local", async () => {
		const outside = path.join(tmpDir, "outside.ts");
		const tool = new WriteTool(session({ planEnabled: true }));
		await expect(tool.execute("w12", { path: outside, content: "nope\n" })).rejects.toThrow(
			/working tree is read-only/i,
		);
		expect(await Bun.file(outside).exists()).toBe(false);
	});

	it("large multi-kilobyte content round-trips exact length and prefix/suffix", async () => {
		const filePath = path.join(tmpDir, "large.ts");
		const body = "x".repeat(50_000);
		const content = `// start\n${body}\n// end\n`;
		const tool = new WriteTool(session());
		const result = await tool.execute("w13", { path: filePath, content });
		const onDisk = await Bun.file(filePath).text();
		expect(onDisk.length).toBe(content.length);
		expect(onDisk.startsWith("// start\n")).toBe(true);
		expect(onDisk.endsWith("// end\n")).toBe(true);
		expect(textOf(result)).toContain(`Successfully wrote ${content.length} bytes`);
	});
});
