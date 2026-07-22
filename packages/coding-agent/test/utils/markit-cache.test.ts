/**
 * Coverage for the document conversion cache layered over the markit wrappers
 * (src/utils/markit + src/utils/markit-cache). Successful conversions are cached
 * by content hash + normalized extension so repeated reads of unchanged bytes
 * reuse converted markdown; failed, empty, and imageDir conversions are never
 * cached. The underlying converter (`Markit.prototype.convert`) is mocked so the
 * tests assert cache hit/miss/skipped behavior and converter call counts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Markit } from "@veyyon/coding-agent/markit";
import { convertBufferWithMarkit, convertFileWithMarkit } from "@veyyon/coding-agent/utils/markit";
import {
	MARKIT_CONVERSION_CACHE_VERSION,
	markitConversionCacheKey,
	pruneMarkitConversionCache,
} from "@veyyon/coding-agent/utils/markit-cache";
import { __resetDirsFromEnvForTests, getAgentDir, Snowflake, setAgentDir } from "@veyyon/utils";

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}

/**
 * markitConversionCacheKey derives the on-disk cache filename for a converted document. It had no
 * direct test. The key must be deterministic for identical (bytes, extension) input, change when the
 * bytes change (it embeds a sha256 of the content), fold the package version and cache-schema version
 * in (so a new release cannot read a stale conversion), and sanitize the extension to a safe token
 * (lowercased, dots stripped, non-alphanumerics collapsed, defaulting to "bin"). A regression that
 * dropped the content digest would serve a wrong cached conversion for different bytes; one that
 * skipped the version fold would read a stale format across an upgrade.
 */
describe("markitConversionCacheKey", () => {
	// sha256 of the three bytes 01 02 03, the digest suffix the key must carry verbatim.
	const digestOf123 = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";

	it("is deterministic and ends with the sha256 of the content bytes", () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const key = markitConversionCacheKey(bytes, "pdf");
		expect(key).toBe(markitConversionCacheKey(new Uint8Array([1, 2, 3]), "pdf"));
		expect(key.endsWith(digestOf123)).toBe(true);
		expect(key.startsWith(`v${MARKIT_CONVERSION_CACHE_VERSION}-`)).toBe(true);
	});

	it("changes the key when the content bytes change", () => {
		expect(markitConversionCacheKey(new Uint8Array([1, 2, 3]), "pdf")).not.toBe(
			markitConversionCacheKey(new Uint8Array([1, 2, 4]), "pdf"),
		);
	});

	it("normalizes the extension: lowercased, leading dots stripped, so .PDF and pdf share a key", () => {
		const bytes = new Uint8Array([1, 2, 3]);
		expect(markitConversionCacheKey(bytes, ".PDF")).toBe(markitConversionCacheKey(bytes, "pdf"));
	});

	it("sanitizes non-alphanumeric extension characters into underscores", () => {
		const key = markitConversionCacheKey(new Uint8Array([1, 2, 3]), "  ta r!!");
		expect(key).toContain("-ta_r_-");
	});

	it("falls back to the 'bin' token for an empty or dots-only extension", () => {
		const bytes = new Uint8Array([1, 2, 3]);
		expect(markitConversionCacheKey(bytes, "")).toContain("-bin-");
		expect(markitConversionCacheKey(bytes, "...")).toContain("-bin-");
	});
});

describe("document conversion cache", () => {
	let testDir: string;
	let originalPiCodingAgentDir: string | undefined;
	let originalVeyyonProfile: string | undefined;
	let originalPiProfile: string | undefined;
	let originalXdgCacheHome: string | undefined;

	beforeEach(async () => {
		originalPiCodingAgentDir = process.env.VEYYON_CODING_AGENT_DIR;
		originalVeyyonProfile = process.env.VEYYON_PROFILE;
		originalPiProfile = process.env.VEYYON_PROFILE;
		originalXdgCacheHome = process.env.XDG_CACHE_HOME;
		testDir = path.join(os.tmpdir(), `markit-cache-${Snowflake.next()}`);
		await fs.mkdir(testDir, { recursive: true });
		setAgentDir(path.join(testDir, "agent"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		restoreEnv("VEYYON_CODING_AGENT_DIR", originalPiCodingAgentDir);
		restoreEnv("VEYYON_PROFILE", originalVeyyonProfile);
		restoreEnv("VEYYON_PROFILE", originalPiProfile);
		restoreEnv("XDG_CACHE_HOME", originalXdgCacheHome);
		__resetDirsFromEnvForTests();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("caches successful buffer conversions by content hash and normalized extension", async () => {
		const convert = vi.spyOn(Markit.prototype, "convert").mockResolvedValue({ markdown: "cached body" });
		const bytes = new TextEncoder().encode("hello pdf bytes");

		const first = await convertBufferWithMarkit(bytes, "pdf");
		expect(first).toEqual({ ok: true, content: "cached body", cache: "miss" });

		const second = await convertBufferWithMarkit(bytes, ".pdf");
		expect(second).toEqual({ ok: true, content: "cached body", cache: "hit" });

		expect(convert).toHaveBeenCalledTimes(1);
	});

	it("does not cache failed conversions", async () => {
		const convert = vi.spyOn(Markit.prototype, "convert");
		convert.mockRejectedValueOnce(new Error("boom"));
		const bytes = new TextEncoder().encode("retry me");

		const first = await convertBufferWithMarkit(bytes, ".pdf");
		expect(first.ok).toBe(false);

		convert.mockResolvedValueOnce({ markdown: "recovered" });
		const second = await convertBufferWithMarkit(bytes, ".pdf");
		expect(second.ok).toBe(true);
		expect(second.content).toBe("recovered");
		expect(second.cache).toBe("miss");

		expect(convert).toHaveBeenCalledTimes(2);
	});

	it("invalidates file conversions by content hash", async () => {
		const convert = vi.spyOn(Markit.prototype, "convert");
		const docPath = path.join(testDir, "doc.pdf");

		await fs.writeFile(docPath, new TextEncoder().encode("v1"));
		convert.mockResolvedValueOnce({ markdown: "first" });
		const v1 = await convertFileWithMarkit(docPath);
		expect(v1.cache).toBe("miss");
		expect(v1.content).toBe("first");

		await fs.writeFile(docPath, new TextEncoder().encode("v2"));
		convert.mockResolvedValueOnce({ markdown: "second" });
		const v2 = await convertFileWithMarkit(docPath);
		expect(v2.cache).toBe("miss");
		expect(v2.content).toBe("second");

		const v2Again = await convertFileWithMarkit(docPath);
		expect(v2Again.cache).toBe("hit");
		expect(v2Again.content).toBe("second");

		expect(convert).toHaveBeenCalledTimes(2);
	});

	it("skips cache for imageDir conversions", async () => {
		const convert = vi.spyOn(Markit.prototype, "convert").mockResolvedValue({ markdown: "image body" });
		const docPath = path.join(testDir, "image-doc.pdf");
		await fs.writeFile(docPath, new TextEncoder().encode("image bytes"));
		const imageDir = path.join(testDir, "images");

		const first = await convertFileWithMarkit(docPath, undefined, { imageDir });
		expect(first.cache).toBe("skipped");

		const second = await convertFileWithMarkit(docPath, undefined, { imageDir });
		expect(second.cache).toBe("skipped");

		expect(convert).toHaveBeenCalledTimes(2);
	});

	it("sweeps orphaned .tmp files during prune", async () => {
		const cacheDir = path.join(getAgentDir(), "cache", "document-conversions");
		await fs.mkdir(cacheDir, { recursive: true });

		const stalePath = path.join(cacheDir, "orphan.123.456.tmp");
		const freshPath = path.join(cacheDir, "active.789.012.tmp");
		await fs.writeFile(stalePath, "stale");
		await fs.writeFile(freshPath, "fresh");
		const old = new Date(Date.now() - 60 * 60 * 1000);
		await fs.utimes(stalePath, old, old);

		await pruneMarkitConversionCache(cacheDir);

		expect(await fs.exists(stalePath)).toBe(false);
		expect(await fs.exists(freshPath)).toBe(true);
	});
});
