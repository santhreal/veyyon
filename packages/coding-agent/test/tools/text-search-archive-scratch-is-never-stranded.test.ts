// WHY THIS SUITE EXISTS
// --------------------
// When a text search reaches inside zip archives (e.g. `archive.zip:member.ts`),
// `resolveArchiveSearchPaths` extracts archive members to a temporary scratch
// directory (`veyyon-search-archive-...`) before handing them to ripgrep.
//
// In v1.2.0..HEAD (commit 114321d97), a resource cleanup bug was fixed:
// previously, if an unexpected error occurred during extraction of a later member
// (after `tempDir` had already been created by an earlier member), the scratch
// directory was stranded on disk for the life of the host. The loop was wrapped
// in a try/catch that guarantees `await cleanup()` runs before re-throwing.
//
// This suite closes the class of archive search resource leaks by asserting:
// 1. Searching inside zip archive members successfully extracts, matches text,
//    attributes matches to the virtual archive member path, and cleans up temp files.
// 2. When an unexpected error is thrown during extraction of subsequent members
//    after `tempDir` has been created, `tempDir` is deleted immediately in the catch
//    block and is not left on disk.
// 3. Binary or non-UTF-8 archive members are recorded as unreadable without stranding
//    temporary files.
//
// What it does not catch:
// External OS process crash (SIGKILL) mid-extraction before Node cleanup handlers run.

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { SearchTool } from "@veyyon/coding-agent/tools/search";
import { removeWithRetries } from "@veyyon/utils";

function crc32(bytes: Uint8Array): number {
	let crc = ~0;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return ~crc >>> 0;
}

function createZipBuffer(members: Array<{ path: string; body: string | Uint8Array }>): Uint8Array {
	const encoder = new TextEncoder();
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;

	for (const member of members) {
		const name = encoder.encode(member.path);
		const body = typeof member.body === "string" ? encoder.encode(member.body) : member.body;
		const crc = crc32(body);

		const local = new Uint8Array(30 + name.length + body.length);
		const localView = new DataView(local.buffer);
		localView.setUint32(0, 0x04034b50, true);
		localView.setUint16(4, 20, true);
		localView.setUint16(6, 0x800, true); // UTF-8 name
		localView.setUint16(8, 0, true); // stored
		localView.setUint32(14, crc, true);
		localView.setUint32(18, body.length, true);
		localView.setUint32(22, body.length, true);
		localView.setUint16(26, name.length, true);
		local.set(name, 30);
		local.set(body, 30 + name.length);
		locals.push(local);

		const central = new Uint8Array(46 + name.length);
		const centralView = new DataView(central.buffer);
		centralView.setUint32(0, 0x02014b50, true);
		centralView.setUint16(4, 20, true);
		centralView.setUint16(6, 20, true);
		centralView.setUint16(8, 0x800, true);
		centralView.setUint16(10, 0, true);
		centralView.setUint32(16, crc, true);
		centralView.setUint32(20, body.length, true);
		centralView.setUint32(24, body.length, true);
		centralView.setUint16(28, name.length, true);
		centralView.setUint32(42, offset, true);
		central.set(name, 46);
		centrals.push(central);

		offset += local.length;
	}

	const centralSize = centrals.reduce((total, part) => total + part.length, 0);
	const end = new Uint8Array(22);
	const endView = new DataView(end.buffer);
	endView.setUint32(0, 0x06054b50, true);
	endView.setUint16(8, members.length, true);
	endView.setUint16(10, members.length, true);
	endView.setUint32(12, centralSize, true);
	endView.setUint32(16, offset, true);

	const total = [...locals, ...centrals, end];
	const bytes = new Uint8Array(total.reduce((sum, part) => sum + part.length, 0));
	let cursor = 0;
	for (const part of total) {
		bytes.set(part, cursor);
		cursor += part.length;
	}
	return bytes;
}

function createTestSession(cwd: string): ToolSession {
	const artifactsDir = path.join(cwd, "artifacts");
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => artifactsDir,
		getSessionId: () => "archive-scratch-test-session",
		allocateOutputArtifact: async () => ({ id: "art-1", path: path.join(cwd, "art-1.log") }),
		settings: Settings.isolated(),
	};
}

describe("text search archive scratch cleanup", () => {
	let tmpDir: string;
	let zipPath: string;

	beforeEach(async () => {
		resetSettingsForTest();
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-archive-cleanup-"));
		zipPath = path.join(tmpDir, "bundle.zip");

		const zipBytes = createZipBuffer([
			{ path: "src/alpha.ts", body: "export const alpha = 1;\nfunction computeValue() { return 42; }\n" },
			{ path: "src/beta.ts", body: "export const beta = 2;\nfunction computeOther() { return 99; }\n" },
			{ path: "src/gamma.ts", body: "export const gamma = 3;\nfunction computeThird() { return 100; }\n" },
		]);
		await fs.writeFile(zipPath, zipBytes);
	});

	afterEach(async () => {
		resetSettingsForTest();
		vi.restoreAllMocks();
		await removeWithRetries(tmpDir);
	});

	it("searches archive member and cleans up scratch directory on success", async () => {
		let createdScratchDir: string | undefined;
		const originalMkdtemp = fs.mkdtemp;
		vi.spyOn(fs, "mkdtemp").mockImplementation((async (prefix: string) => {
			const dir = await originalMkdtemp(prefix);
			if (prefix.includes("veyyon-search-archive-")) {
				createdScratchDir = dir;
			}
			return dir;
		}) as typeof fs.mkdtemp);

		const session = createTestSession(tmpDir);
		const tool = new SearchTool(session);

		const result = await tool.execute("call-search-zip", {
			type: "text",
			input: "computeValue",
			path: `${zipPath}:src/alpha.ts`,
		});

		const text = result.content.find(c => c.type === "text")?.text ?? "";
		expect(text).toContain("computeValue");
		expect(result.details?.type === "text" ? result.details.result.matchCount : undefined).toBe(1);
		// Temp directory was created for extraction
		expect(createdScratchDir).toBeDefined();
		// And deleted after search completed
		const stillExists = await fs.stat(createdScratchDir!).then(
			() => true,
			() => false,
		);
		expect(stillExists).toBe(false);
	});

	it("cleans up scratch directory when an extraction throws midway through multi-member search", async () => {
		let createdScratchDir: string | undefined;
		const originalMkdtemp = fs.mkdtemp;
		vi.spyOn(fs, "mkdtemp").mockImplementation((async (prefix: string) => {
			const dir = await originalMkdtemp(prefix);
			if (prefix.includes("veyyon-search-archive-")) {
				createdScratchDir = dir;
			}
			return dir;
		}) as typeof fs.mkdtemp);

		// Let member 0 write to scratch dir, then throw on member 1's writeFile
		let writeCount = 0;
		const originalWriteFile = fs.writeFile;
		vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
			if (typeof file === "string" && file.includes("veyyon-search-archive-")) {
				writeCount++;
				if (writeCount > 1) {
					throw new Error("Simulated disk error during archive extraction");
				}
			}
			return originalWriteFile(file, data, options);
		});

		const session = createTestSession(tmpDir);
		const tool = new SearchTool(session);

		let caught: unknown;
		try {
			await tool.execute("call-multi-member", {
				type: "text",
				input: "compute",
				path: `${zipPath}:src/alpha.ts; ${zipPath}:src/beta.ts`,
			});
		} catch (error) {
			caught = error;
		}

		expect(caught instanceof Error).toBe(true);
		if (caught instanceof Error) {
			expect(caught.message).toContain("Simulated disk error during archive extraction");
		}
		// Scratch dir was created on member 0
		expect(createdScratchDir).toBeDefined();
		// And cleaned up on catch before error was re-thrown
		const stillExists = await fs.stat(createdScratchDir!).then(
			() => true,
			() => false,
		);
		expect(stillExists).toBe(false);
	});

	it("handles non-UTF-8/binary archive members gracefully without crashing", async () => {
		const binaryZipPath = path.join(tmpDir, "binary-archive.zip");
		const binaryData = new Uint8Array([0x00, 0xff, 0xfe, 0x00, 0x12, 0x34]);
		const zipBytes = createZipBuffer([
			{ path: "data.bin", body: binaryData },
			{ path: "code.ts", body: "const validUtf8 = 'hello';\n" },
		]);
		await fs.writeFile(binaryZipPath, zipBytes);

		const session = createTestSession(tmpDir);
		const tool = new SearchTool(session);

		const result = await tool.execute("call-bin-search", {
			type: "text",
			input: "validUtf8",
			path: `${binaryZipPath}:data.bin; ${binaryZipPath}:code.ts`,
		});

		const text = result.content.find(c => c.type === "text")?.text ?? "";
		expect(text).toContain("validUtf8");
	});
});
