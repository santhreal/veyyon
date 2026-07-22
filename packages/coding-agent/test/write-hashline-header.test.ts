import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { canonicalSnapshotKey, getFileSnapshotStore } from "@veyyon/coding-agent/edit/file-snapshot-store";
import { HashlineFilesystem } from "@veyyon/coding-agent/edit/hashline/filesystem";
import { writethroughNoop } from "@veyyon/coding-agent/lsp";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { WriteTool } from "@veyyon/coding-agent/tools/write";
import { Patch, Patcher } from "@veyyon/hashline";
import { removeWithRetries } from "@veyyon/utils";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		enableLsp: false,
	};
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

const HASHLINE_HEADER_LINE = /^\[([^#\r\n]+)#([0-9A-F]{4})\]$/;

describe("write tool hashline header", () => {
	let tmpDir: string;

	// This suite needs the global `Settings` singleton: the hashline Patcher path
	// exercised by "makes the post-write tag usable by the hashline patcher" reads
	// the process-wide `settings`. `Settings.init` is guarded to initialize once per
	// process, so without the reset guards below a stray init from an earlier file
	// in the same CI chunk would win and hand THIS suite the wrong instance, and our
	// init would in turn leak forward and silently no-op the next file's
	// `Settings.init({ agentDir })` (the exact cross-file contamination that broke
	// session-workdir-settings-ui when co-run). `resetSettingsForTest` before init
	// claims a clean slate, and the afterAll reset releases the guard for the next
	// file. See test/config/settings-init-isolation.test.ts for the locked contract.
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-hashline-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("inserts a fresh [path#TAG] header that maps to the written content", async () => {
		const filePath = path.join(tmpDir, "module.ts");
		const session = createSession(tmpDir);
		const tool = new WriteTool(session);
		const content = "export const value = 42;\nexport const flag = true;\n";

		const result = await tool.execute("call-1", { path: filePath, content });
		const lines = resultText(result).split("\n");

		// First line is the hashline header; subsequent text is the byte count.
		const match = HASHLINE_HEADER_LINE.exec(lines[0] ?? "");
		expect(match).not.toBeNull();
		const [, headerPath, tag] = match!;
		expect(headerPath).toBe(path.relative(tmpDir, filePath));
		expect(lines[1]).toBe(`Successfully wrote ${content.length} bytes to ${headerPath}`);

		// The tag must address a snapshot whose content matches what we wrote so a
		// follow-up edit can land without an extra `read` round-trip.
		const snapshot = getFileSnapshotStore(session).byHash(canonicalSnapshotKey(filePath), tag!);
		expect(snapshot).not.toBeNull();
		expect(snapshot?.text).toBe(content);
	});

	it("makes the post-write tag usable by the hashline patcher", async () => {
		const filePath = path.join(tmpDir, "config.ts");
		const session = createSession(tmpDir);
		const tool = new WriteTool(session);
		const content = "export const enabled = false;\n";

		const writeResult = await tool.execute("call-1", { path: filePath, content });
		const headerLine = resultText(writeResult).split("\n")[0] ?? "";
		expect(HASHLINE_HEADER_LINE.test(headerLine)).toBe(true);

		// Apply a hashline patch immediately, using only the tag the write tool
		// returned — no intervening `read`.
		const patchInput = `${headerLine}\nSWAP 1.=1:\n+export const enabled = true;\n`;
		const patch = Patch.parse(patchInput, { cwd: tmpDir });
		expect(patch.sections).toHaveLength(1);

		const filesystem = new HashlineFilesystem({
			session,
			writethrough: writethroughNoop,
			beginDeferredDiagnosticsForPath: () => {
				throw new Error("deferred diagnostics unused with writethroughNoop");
			},
		});
		const patcher = new Patcher({ fs: filesystem, snapshots: getFileSnapshotStore(session) });
		const prepared = await patcher.prepare(patch.sections[0]!);
		const sectionResult = await patcher.commit(prepared);
		expect(sectionResult.op).toBe("update");

		const final = await fs.readFile(filePath, "utf8");
		expect(final).toBe("export const enabled = true;\n");
	});

	it("omits the hashline header when the edit mode is not hashline", async () => {
		const filePath = path.join(tmpDir, "plain.txt");
		const session = createSession(tmpDir);
		session.settings.set("edit.mode", "replace");
		const tool = new WriteTool(session);
		const content = "no anchors here\n";

		const result = await tool.execute("call-1", { path: filePath, content });
		const text = resultText(result);
		expect(text.startsWith("[")).toBe(false);
		expect(text).toBe(`Successfully wrote ${content.length} bytes to ${path.relative(tmpDir, filePath)}`);
	});

	// TW-3: the write result body reports only a summary (byte count), never the
	// resulting file content the model already supplied as input. Re-echoing the
	// content would double its token cost in wire history for the whole session.
	it("reports only a byte-count summary, never the written content (replace mode)", async () => {
		const filePath = path.join(tmpDir, "big.txt");
		const session = createSession(tmpDir);
		session.settings.set("edit.mode", "replace");
		const tool = new WriteTool(session);
		const sentinel = "PAYLOAD_LINE_UNIQUE_MARKER_9f2a\n";
		const content = sentinel.repeat(2000); // ~62 KB of distinctive content

		const result = await tool.execute("call-1", { path: filePath, content });
		const text = resultText(result);

		// Exact summary, and not one byte of the payload leaks into the result.
		expect(text).toBe(`Successfully wrote ${content.length} bytes to ${path.relative(tmpDir, filePath)}`);
		expect(text).not.toContain(sentinel);
		// The result stays tiny regardless of how large the file is.
		expect(text.length).toBeLessThan(200);
		// The file itself did get the full content.
		expect(await fs.readFile(filePath, "utf8")).toBe(content);
	});

	it("keeps the result body bounded and content-free in hashline mode", async () => {
		const filePath = path.join(tmpDir, "big.ts");
		const session = createSession(tmpDir);
		const tool = new WriteTool(session);
		const sentinel = "export const UNIQUE_TOKEN_7e10 = true;\n";
		const content = sentinel.repeat(2000);

		const result = await tool.execute("call-1", { path: filePath, content });
		const text = resultText(result);

		// Header line + summary line only; the payload never appears.
		expect(text).not.toContain(sentinel);
		expect(text.length).toBeLessThan(200);
		const lines = text.split("\n");
		expect(HASHLINE_HEADER_LINE.test(lines[0] ?? "")).toBe(true);
		expect(lines[1]).toBe(`Successfully wrote ${content.length} bytes to ${path.relative(tmpDir, filePath)}`);
	});
});
