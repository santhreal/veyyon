/**
 * WHY: `downloadTool` fetched a third-party binary from a GitHub release, chmod'd it 0755 and ran
 * it, with no checksum anywhere on the path. Every other download in the tree (the self-updater,
 * install.sh, install.ps1) fails closed on a missing or mismatched digest; this one accepted
 * whatever bytes arrived. Whoever controls the upstream release, or a TLS-intercepting proxy whose
 * CA the user trusts, got code execution as the user the first time the agent decided it needed
 * `sd` or `ast-grep`.
 *
 * The contract these tests defend:
 *   - a release that publishes no usable sha256 for the asset is refused before anything is
 *     written or made executable;
 *   - bytes that do not hash to the published digest are refused and the partial file is removed;
 *   - bytes that do hash to it are written unchanged, so the gate is not a blanket deny.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import { downloadFile, downloadTool } from "@veyyon/coding-agent/utils/tools-manager";
import { TempDir } from "@veyyon/utils";

const SD_ASSET_LINUX_X64 = "sd-v1.1.0-x86_64-unknown-linux-musl.tar.gz";

function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Stand in for the GitHub release API plus the asset CDN, so nothing leaves the machine. */
function mockGitHub(release: unknown): void {
	const impl: typeof globalThis.fetch = Object.assign(
		async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.startsWith("https://api.github.com/")) {
				return new Response(JSON.stringify(release), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			throw new Error(`unexpected asset download: ${url}`);
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(impl);
}

describe("tool download checksum gate", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("refuses a release that publishes no digest for the asset, without downloading it", async () => {
		mockGitHub({
			tag_name: "v1.1.0",
			assets: [{ name: SD_ASSET_LINUX_X64, digest: null }],
		});

		await expect(downloadTool("sd")).rejects.toThrow(/publishes no sha256 digest for sd-v1\.1\.0-/);
	});

	it("refuses a digest that is not a well-formed sha256", async () => {
		mockGitHub({
			tag_name: "v1.1.0",
			assets: [{ name: SD_ASSET_LINUX_X64, digest: "sha256:not-a-digest" }],
		});

		await expect(downloadTool("sd")).rejects.toThrow(/publishes no sha256 digest for/);

		mockGitHub({
			tag_name: "v1.1.0",
			assets: [{ name: SD_ASSET_LINUX_X64, digest: "md5:5d41402abc4b2a76b9719d911017c592" }],
		});

		await expect(downloadTool("sd")).rejects.toThrow(/publishes no sha256 digest for/);
	});

	it("refuses tampered bytes and removes the partial file", async () => {
		using tempDir = TempDir.createSync("@veyyon-tool-checksum-");
		const dest = tempDir.join("tool.bin");
		const expected = sha256Hex("honest-bytes");
		const impl: typeof globalThis.fetch = Object.assign(async () => new Response("evil-bytes"), {
			preconnect: globalThis.fetch.preconnect,
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(impl);

		await expect(downloadFile("https://example.test/tool.bin", dest, undefined, expected)).rejects.toThrow(
			`Checksum mismatch for https://example.test/tool.bin: expected sha256 ${expected}, got ${sha256Hex("evil-bytes")}`,
		);
		expect(await Bun.file(dest).exists()).toBe(false);
	});

	it("accepts bytes that match the published digest and writes them unchanged", async () => {
		using tempDir = TempDir.createSync("@veyyon-tool-checksum-ok-");
		const dest = tempDir.join("tool.bin");
		const body = "honest-bytes";
		const impl: typeof globalThis.fetch = Object.assign(async () => new Response(body), {
			preconnect: globalThis.fetch.preconnect,
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(impl);

		await downloadFile("https://example.test/tool.bin", dest, undefined, sha256Hex(body));

		expect(await Bun.file(dest).text()).toBe(body);
	});
});
