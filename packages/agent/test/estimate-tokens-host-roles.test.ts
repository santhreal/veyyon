/**
 * WHY: `walkCountedFragments` in `token-estimate.ts` has two host-role branches
 * that no existing test exercises: `pythonExecution` (counts `code` + `output`
 * string fields, same shape as `bashExecution`) and `fileMention` (counts
 * `path` + `content` per file entry, plus `IMAGE_TOKEN_ESTIMATE` per image).
 * A helper extraction that drops a field, misreads the host-role table, or
 * skips the image surcharge silently mis-estimates context tokens, which feeds
 * the compaction trigger and the operator's context meter.
 *
 * This suite closes the class by covering:
 * - `pythonExecution`: counts code + output, empty yields 0
 * - `fileMention`: counts path + content per entry
 * - `fileMention`: adds exactly IMAGE_TOKEN_ESTIMATE per image
 * - `fileMention`: empty files array yields 0
 * - `fileMention`: entries with only a path (no content) still count
 * - `fileMention`: entries with only content (no path) still count
 * - Cache invalidation: editing a pythonExecution output changes the estimate
 */
import { describe, expect, it } from "bun:test";
import { estimateTokens } from "@veyyon/agent-core/compaction";
import type { ImageContent } from "@veyyon/ai";

const IMAGE_TOKEN_ESTIMATE = 1200;
const IMAGE: ImageContent = { type: "image", data: "AAAA", mimeType: "image/png" };

describe("estimateTokens — pythonExecution role", () => {
	it("counts code + output text", () => {
		const msg = { role: "pythonExecution", code: "print('hello')", output: "hello\n" } as never;
		expect(estimateTokens(msg)).toBeGreaterThan(0);
	});

	it("empty pythonExecution yields 0", () => {
		const msg = { role: "pythonExecution" } as never;
		expect(estimateTokens(msg)).toBe(0);
	});

	it("code-only counts the code field", () => {
		const msg = { role: "pythonExecution", code: "x = 1\ny = 2\n" } as never;
		expect(estimateTokens(msg)).toBeGreaterThan(0);
	});

	it("output-only counts the output field", () => {
		const msg = { role: "pythonExecution", output: "result line 1\nresult line 2\n" } as never;
		expect(estimateTokens(msg)).toBeGreaterThan(0);
	});

	it("estimate changes when output is edited in-place", () => {
		const msg = { role: "pythonExecution", code: "print('hi')", output: "hi\n" } as never;
		const before = estimateTokens(msg);
		(msg as { output: string }).output = "hi\nthere\nmore\nlines\n";
		const after = estimateTokens(msg);
		expect(after).toBeGreaterThan(before);
	});
});

describe("estimateTokens — fileMention role", () => {
	it("counts path + content per file entry", () => {
		const msg = {
			role: "fileMention",
			files: [
				{ path: "/repo/src/a.ts", content: "export const a = 1;\n" },
				{ path: "/repo/src/b.ts", content: "export const b = 2;\n" },
			],
		} as never;
		expect(estimateTokens(msg)).toBeGreaterThan(0);
	});

	it("empty files array yields 0", () => {
		const msg = { role: "fileMention", files: [] } as never;
		expect(estimateTokens(msg)).toBe(0);
	});

	it("missing files field yields 0", () => {
		const msg = { role: "fileMention" } as never;
		expect(estimateTokens(msg)).toBe(0);
	});

	it("adds exactly IMAGE_TOKEN_ESTIMATE per image entry", () => {
		const textOnly = {
			role: "fileMention",
			files: [{ path: "/repo/a.ts", content: "content" }],
		} as never;
		const withImage = {
			role: "fileMention",
			files: [{ path: "/repo/a.ts", content: "content", image: IMAGE }],
		} as never;
		const withTwoImages = {
			role: "fileMention",
			files: [
				{ path: "/repo/a.ts", content: "content", image: IMAGE },
				{ path: "/repo/b.ts", content: "content", image: IMAGE },
			],
		} as never;
		// Two images but also an extra path ("/repo/b.ts") — subtract the path-only delta
		const onePathOnly = {
			role: "fileMention",
			files: [
				{ path: "/repo/a.ts", content: "content" },
				{ path: "/repo/b.ts", content: "content" },
			],
		} as never;
		expect(estimateTokens(withImage) - estimateTokens(textOnly)).toBe(IMAGE_TOKEN_ESTIMATE);
		expect(estimateTokens(withTwoImages) - estimateTokens(onePathOnly)).toBe(2 * IMAGE_TOKEN_ESTIMATE);
	});

	it("path-only entries (no content) still count", () => {
		const msg = {
			role: "fileMention",
			files: [{ path: "/repo/src/a.ts" }],
		} as never;
		expect(estimateTokens(msg)).toBeGreaterThan(0);
	});

	it("content-only entries (no path) still count", () => {
		const msg = {
			role: "fileMention",
			files: [{ content: "just some code\n" }],
		} as never;
		expect(estimateTokens(msg)).toBeGreaterThan(0);
	});

	it("estimate changes when file content is edited in-place", () => {
		const msg = {
			role: "fileMention",
			files: [{ path: "/repo/a.ts", content: "short\n" }],
		} as never;
		const before = estimateTokens(msg);
		(msg as { files: Array<{ content: string }> }).files[0]!.content = "short\nplus much more content\n";
		const after = estimateTokens(msg);
		expect(after).toBeGreaterThan(before);
	});
});
