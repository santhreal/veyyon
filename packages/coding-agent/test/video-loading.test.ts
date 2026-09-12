/**
 * WHY:
 * Video input attachments require format validation and container sniffing
 * from binary magic headers before ingestion into agent context, rejecting
 * unsupported containers and oversized files early with typed errors.
 *
 * This suite defends:
 * 1. ISO BMFF container sniffing via `ftyp` box returns "video/mp4" or "video/quicktime".
 * 2. EBML container sniffing via 1A 45 DF A3 magic header returns "video/webm".
 * 3. Non-video content (e.g. PNG headers) is rejected with `UnsupportedVideoTypeError`.
 * 4. Files exceeding `MAX_VIDEO_INPUT_BYTES` are rejected with `VideoInputTooLargeError`.
 *
 * What it does NOT catch: Video frame decoding or audio stream playback.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	base64DecodedBytes,
	loadVideoInput,
	MAX_VIDEO_INPUT_BYTES,
	sniffVideoMimeType,
	UnsupportedVideoTypeError,
	VideoInputTooLargeError,
} from "../src/utils/video-loading";

describe("video-loading container sniffing and file loading", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "video-loading-test-"));
	});

	afterEach(async () => {
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
	});

	test("sniffVideoMimeType correctly detects MP4, QuickTime, and WebM", () => {
		// ISO BMFF with "isom" brand -> video/mp4
		const mp4Header = Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
		expect(sniffVideoMimeType(mp4Header)).toBe("video/mp4");

		// ISO BMFF with "qt  " brand -> video/quicktime
		const qtHeader = Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20, 0, 0, 0, 0]);
		expect(sniffVideoMimeType(qtHeader)).toBe("video/quicktime");

		// EBML header -> video/webm
		const ebmlHeader = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
		expect(sniffVideoMimeType(ebmlHeader)).toBe("video/webm");

		// PNG magic -> null
		const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		expect(sniffVideoMimeType(pngHeader)).toBeNull();
	});

	test("base64DecodedBytes computes exact decoded length without allocating", () => {
		expect(base64DecodedBytes("")).toBe(0);
		expect(base64DecodedBytes("YQ==")).toBe(1);
		expect(base64DecodedBytes("YWI=")).toBe(2);
		expect(base64DecodedBytes("YWJj")).toBe(3);
		expect(base64DecodedBytes("YWJjZA==")).toBe(4);
		expect(base64DecodedBytes("YWJjZGU=")).toBe(5);
		expect(base64DecodedBytes("YWJjZGVm")).toBe(6);
	});

	test("loadVideoInput loads MP4 fixture correctly", async () => {
		const filePath = path.join(tempDir, "test.mp4");
		const data = Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 1, 2, 3, 4]);
		await fs.writeFile(filePath, data);

		const result = await loadVideoInput({ path: "test.mp4", cwd: tempDir });
		expect(result.mimeType).toBe("video/mp4");
		expect(result.bytes).toBe(data.byteLength);
		expect(result.data).toBe(data.toString("base64"));
		expect(result.resolvedPath).toBe(filePath);
	});

	test("loadVideoInput loads WebM fixture correctly", async () => {
		const filePath = path.join(tempDir, "test.webm");
		const data = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x02]);
		await fs.writeFile(filePath, data);

		const result = await loadVideoInput({ path: "test.webm", cwd: tempDir });
		expect(result.mimeType).toBe("video/webm");
		expect(result.bytes).toBe(data.byteLength);
		expect(result.data).toBe(data.toString("base64"));
	});

	test("loadVideoInput rejects non-video content with UnsupportedVideoTypeError", async () => {
		const filePath = path.join(tempDir, "image.png");
		const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
		await fs.writeFile(filePath, data);

		expect(loadVideoInput({ path: "image.png", cwd: tempDir })).rejects.toThrow(UnsupportedVideoTypeError);
	});

	test("loadVideoInput rejects oversize file with VideoInputTooLargeError", async () => {
		const filePath = path.join(tempDir, "large.mp4");
		const header = Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
		const handle = await fs.open(filePath, "w");
		await handle.write(header);
		await handle.truncate(MAX_VIDEO_INPUT_BYTES + 1024);
		await handle.close();

		expect(loadVideoInput({ path: "large.mp4", cwd: tempDir })).rejects.toThrow(VideoInputTooLargeError);
	});
});
