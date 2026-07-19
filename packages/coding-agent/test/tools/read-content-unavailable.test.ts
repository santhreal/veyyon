/**
 * The read tool marks a refusal it cannot deliver as text with
 * `details.contentUnavailable` (BACKLOG READ-CLI-BINARY-EXIT0). The result
 * stays non-`isError` on purpose so the agent keeps the `:raw`/guidance hint
 * without a retry storm; the marker is what lets the `veyyon read` CLI exit
 * non-zero instead of reporting the refusal as success. A readable text file
 * carries no marker.
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

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "read.summarize.enabled": false }),
	} as unknown as ToolSession;
}

function unavailable(result: { details?: unknown }): { reason: string } | undefined {
	return (result.details as { contentUnavailable?: { reason: string } } | undefined)?.contentUnavailable;
}

describe("read tool contentUnavailable marker", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-content-unavailable-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("marks a binary file as contentUnavailable while staying non-error", async () => {
		const binPath = path.join(tmpDir, "blob.bin");
		await Bun.write(binPath, new Uint8Array([0x00, 0xff, 0xfe, 0x00, 0x01, 0x02]));

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("read-binary", { path: binPath });

		expect(unavailable(result)).toEqual({ reason: "binary" });
		expect(result.isError).toBeUndefined();
	});

	it("marks a binary archive member as contentUnavailable", async () => {
		const archivePath = path.join(tmpDir, "data.zip");
		await Bun.write(archivePath, zip({ "binary.dat": new Uint8Array([0x41, 0x00, 0x42]) }));

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("read-archive-binary", { path: `${archivePath}:binary.dat` });

		expect(unavailable(result)).toEqual({ reason: "binary" });
		expect(result.isError).toBeUndefined();
	});

	it("does not mark a readable text file", async () => {
		const textPath = path.join(tmpDir, "notes.txt");
		await Bun.write(textPath, "alpha\nbeta\n");

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("read-text", { path: textPath });

		expect(unavailable(result)).toBeUndefined();
	});

	it("does not mark reading the same binary file with :raw", async () => {
		const binPath = path.join(tmpDir, "blob.bin");
		await Bun.write(binPath, new Uint8Array([0x00, 0xff, 0xfe, 0x00, 0x01, 0x02]));

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("read-binary-raw", { path: `${binPath}:raw` });

		expect(unavailable(result)).toBeUndefined();
	});
});
