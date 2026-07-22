import { afterEach, describe, expect, it, vi } from "bun:test";
import { downloadFile, ffmpegAssetName } from "@veyyon/coding-agent/utils/tools-manager";
import { TempDir } from "@veyyon/utils";

/**
 * ffmpegAssetName maps a (platform, architecture) pair to the published ffmpeg asset filename to
 * download, or null when no prebuilt asset exists for that pair. It had no direct test. The branch
 * table is the contract, and the null cases are the ones a download regression would silently break:
 *   - only arm64 and x64 are supported architectures; anything else (ia32, riscv, ...) is null;
 *   - darwin and linux ship both arm64 and x64 assets;
 *   - win32 ships x64 ONLY - win32/arm64 is null (there is no Windows arm ffmpeg build), which must not
 *     be mistaken for a downloadable asset;
 *   - an unknown platform is null.
 * The version argument is not part of the name and must not change the result.
 */
describe("ffmpegAssetName", () => {
	it("names the darwin and linux assets for both supported architectures", () => {
		expect(ffmpegAssetName("6.0", "darwin", "arm64")).toBe("ffmpeg-darwin-arm64");
		expect(ffmpegAssetName("6.0", "darwin", "x64")).toBe("ffmpeg-darwin-x64");
		expect(ffmpegAssetName("6.0", "linux", "arm64")).toBe("ffmpeg-linux-arm64");
		expect(ffmpegAssetName("6.0", "linux", "x64")).toBe("ffmpeg-linux-x64");
	});

	it("names only the x64 asset on win32 and returns null for win32/arm64", () => {
		expect(ffmpegAssetName("6.0", "win32", "x64")).toBe("ffmpeg-win32-x64");
		expect(ffmpegAssetName("6.0", "win32", "arm64")).toBeNull();
	});

	it("returns null for an unsupported architecture regardless of platform", () => {
		expect(ffmpegAssetName("6.0", "linux", "ia32")).toBeNull();
		expect(ffmpegAssetName("6.0", "darwin", "riscv64")).toBeNull();
	});

	it("returns null for an unknown platform", () => {
		expect(ffmpegAssetName("6.0", "freebsd", "x64")).toBeNull();
	});

	it("ignores the version argument", () => {
		expect(ffmpegAssetName("1.0", "linux", "x64")).toBe(ffmpegAssetName("99.9", "linux", "x64"));
	});
});

function mockDownloadResponse(response: Response): void {
	const fetchMock: typeof globalThis.fetch = Object.assign(async () => response, {
		preconnect: globalThis.fetch.preconnect,
	});
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
}

describe("tool asset downloads", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("writes a completed response body to disk", async () => {
		using tempDir = TempDir.createSync("@veyyon-tool-download-");
		const dest = tempDir.join("tool.bin");
		mockDownloadResponse(new Response("tool-bytes"));

		await downloadFile("https://example.test/tool.bin", dest);

		expect(await Bun.file(dest).text()).toBe("tool-bytes");
	});

	it("aborts a stalled response body and removes the partial file", async () => {
		using tempDir = TempDir.createSync("@veyyon-tool-download-stall-");
		const dest = tempDir.join("tool.bin");
		const stalled = Promise.withResolvers<void>();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("partial"));
			},
			pull() {
				stalled.resolve();
			},
		});
		mockDownloadResponse(new Response(body));
		const controller = new AbortController();

		const download = downloadFile("https://example.test/tool.bin", dest, controller.signal);
		await stalled.promise;
		controller.abort(new DOMException("The operation timed out.", "TimeoutError"));

		await expect(download).rejects.toThrow("Download timed out: https://example.test/tool.bin");
		expect(await Bun.file(dest).exists()).toBe(false);
	});
});
