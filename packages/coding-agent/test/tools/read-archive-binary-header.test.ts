/**
 * SPEC-ONE-PLACE-AUDIT F8: the archive in-memory read branch used to
 * re-implement the NUL-byte half of `isProbablyBinaryHeader` inline
 * (`bytes.indexOf(0) !== -1`) instead of calling the shared predicate. It now
 * calls `isProbablyBinaryHeader` directly — single owner for the "is this
 * binary" classification, exercised end-to-end through the read tool's
 * archive-member path.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { ReadTool } from "@veyyon/coding-agent/tools/read";
import { zip } from "@veyyon/coding-agent/utils/zip";
import { removeWithRetries } from "@veyyon/utils";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "read.summarize.enabled": false }),
	} as unknown as ToolSession;
}

describe("archive in-memory read binary detection (F8)", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-archive-binary-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("reports a NUL-containing archive member as binary", async () => {
		const archivePath = path.join(tmpDir, "data.zip");
		await Bun.write(archivePath, zip({ "binary.dat": new Uint8Array([0x41, 0x00, 0x42]) }));

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("read-archive-nul", { path: `${archivePath}:binary.dat` });
		const output = getText(result);

		expect(output).toContain("Cannot read binary archive entry");
	});

	it("reports an invalid-UTF-8 (non-NUL) archive member as binary", async () => {
		// A lone continuation byte (0x80) with no NUL anywhere — invalid UTF-8
		// caught by the fatal decode inside isProbablyBinaryHeader.
		const archivePath = path.join(tmpDir, "invalid-utf8.zip");
		await Bun.write(archivePath, zip({ "garbage.bin": new Uint8Array([0x41, 0x80, 0x42]) }));

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("read-archive-invalid-utf8", { path: `${archivePath}:garbage.bin` });
		const output = getText(result);

		expect(output).toContain("Cannot read binary archive entry");
	});

	it("still reads a valid UTF-8 text archive member", async () => {
		const archivePath = path.join(tmpDir, "text.zip");
		await Bun.write(archivePath, zip({ "notes.txt": new TextEncoder().encode("hello from inside the zip\n") }));

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("read-archive-text", { path: `${archivePath}:notes.txt` });
		const output = getText(result);

		expect(output).toContain("hello from inside the zip");
		expect(output).not.toContain("Cannot read binary archive entry");
	});
});
