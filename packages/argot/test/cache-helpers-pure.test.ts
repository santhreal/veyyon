import { describe, expect, it } from "bun:test";
import { cacheDictPath, listingSignature } from "../src/cache";
import type { RepoFile } from "../src/generate";

describe("cacheDictPath", () => {
	it("joins baseDir, cacheId, and contentSig", () => {
		const path = cacheDictPath("/cache", "repo-abc", "sig123");
		expect(path).toBe("/cache/repo-abc/sig123.dict");
	});
	it("handles relative baseDir", () => {
		const path = cacheDictPath("cache", "id1", "sig1");
		expect(path).toBe("cache/id1/sig1.dict");
	});
	it("handles nested baseDir", () => {
		const path = cacheDictPath("/a/b/c", "id", "sig");
		expect(path).toBe("/a/b/c/id/sig.dict");
	});
	it("handles empty cacheId", () => {
		const path = cacheDictPath("/cache", "", "sig");
		expect(path).toBe("/cache/sig.dict");
	});
});

describe("listingSignature", () => {
	it("returns a 32-char hex string", () => {
		const files: RepoFile[] = [{ path: "a.ts", content: "hello" }];
		const sig = listingSignature(files);
		expect(sig).toHaveLength(32);
		expect(sig).toMatch(/^[0-9a-f]+$/);
	});
	it("returns same signature for same files", () => {
		const files: RepoFile[] = [
			{ path: "a.ts", content: "hello" },
			{ path: "b.ts", content: "world" },
		];
		expect(listingSignature(files)).toBe(listingSignature(files));
	});
	it("returns different signature for different content", () => {
		const files1: RepoFile[] = [{ path: "a.ts", content: "hello" }];
		const files2: RepoFile[] = [{ path: "a.ts", content: "world" }];
		expect(listingSignature(files1)).not.toBe(listingSignature(files2));
	});
	it("returns different signature for different paths", () => {
		const files1: RepoFile[] = [{ path: "a.ts", content: "hello" }];
		const files2: RepoFile[] = [{ path: "b.ts", content: "hello" }];
		expect(listingSignature(files1)).not.toBe(listingSignature(files2));
	});
	it("handles empty files array", () => {
		const sig = listingSignature([]);
		expect(sig).toHaveLength(32);
	});
	it("handles files with undefined content", () => {
		const files: RepoFile[] = [{ path: "a.ts", content: undefined }];
		expect(() => listingSignature(files)).not.toThrow();
	});
	it("is order-independent (sorts lines)", () => {
		const files1: RepoFile[] = [
			{ path: "b.ts", content: "world" },
			{ path: "a.ts", content: "hello" },
		];
		const files2: RepoFile[] = [
			{ path: "a.ts", content: "hello" },
			{ path: "b.ts", content: "world" },
		];
		expect(listingSignature(files1)).toBe(listingSignature(files2));
	});
	it("handles duplicate paths", () => {
		const files: RepoFile[] = [
			{ path: "a.ts", content: "hello" },
			{ path: "a.ts", content: "hello" },
		];
		expect(() => listingSignature(files)).not.toThrow();
	});
});
