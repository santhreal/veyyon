import { describe, expect, it } from "bun:test";
import {
	getParallelExtractContent,
	parseParallelErrorResponse,
	parseParallelSearchPayload,
} from "@veyyon/coding-agent/web/parallel";

/**
 * The pure decoders for the Parallel web-search API had no tests. They turn raw HTTP
 * responses into the shapes the search tool consumes, so a decoding regression silently
 * drops results, mislabels errors, or loses the content the model reads. Pinned:
 *   - parseParallelErrorResponse builds "Parallel API error (<code>): <detail>", pulling
 *     the detail from message/detail/error or a nested error.message, falling back to the
 *     raw body when there is no recognizable message, and omitting the detail entirely for
 *     an empty body — always preserving the status code;
 *   - parseParallelSearchPayload maps results (skipping entries with no url, defaulting the
 *     title to the url, joining excerpts into a snippet, renaming publish_date), reads
 *     search_id as the request id, and honors parseMetadata:false by emptying warnings/usage;
 *     a non-object payload throws ParallelApiError;
 *   - getParallelExtractContent prefers the joined non-blank excerpts and falls back to the
 *     trimmed fullContent, returning "" when both are empty.
 */

describe("parseParallelErrorResponse", () => {
	it("uses no detail for an empty body but keeps the status code", () => {
		const err = parseParallelErrorResponse(500, "   ");
		expect(err.message).toBe("Parallel API error (500)");
		expect(err.statusCode).toBe(500);
	});

	it("extracts a top-level and a nested error message", () => {
		expect(parseParallelErrorResponse(400, '{"message":"bad key"}').message).toBe(
			"Parallel API error (400): bad key",
		);
		expect(parseParallelErrorResponse(403, '{"error":{"message":"forbidden"}}').message).toBe(
			"Parallel API error (403): forbidden",
		);
	});

	it("falls back to the raw body when there is no recognizable message", () => {
		expect(parseParallelErrorResponse(429, '{"foo":1}').message).toBe('Parallel API error (429): {"foo":1}');
		expect(parseParallelErrorResponse(502, "Gateway Timeout").message).toBe(
			"Parallel API error (502): Gateway Timeout",
		);
	});
});

describe("parseParallelSearchPayload", () => {
	it("maps results, skips url-less entries, and reads metadata by default", () => {
		const result = parseParallelSearchPayload({
			search_id: "abc",
			results: [
				{ url: "https://a.com", title: "A", excerpts: ["e1", "e2"], publish_date: "2026-01-01" },
				{ title: "nourl" },
				{ url: "https://b.com" },
			],
			warnings: ["w1", { message: "w2" }],
			usage: [{ name: "search", count: 3 }],
		});
		expect(result.requestId).toBe("abc");
		expect(result.sources).toEqual([
			{
				title: "A",
				url: "https://a.com",
				snippet: "e1\n\ne2",
				publishedDate: "2026-01-01",
				excerpts: ["e1", "e2"],
			},
			{ title: "https://b.com", url: "https://b.com", snippet: undefined, publishedDate: undefined, excerpts: [] },
		]);
		expect(result.warnings).toEqual(["w1", "w2"]);
		expect(result.usage).toEqual([{ name: "search", count: 3 }]);
	});

	it("empties warnings/usage and defaults requestId when parseMetadata is false", () => {
		const result = parseParallelSearchPayload({ results: [] }, { parseMetadata: false });
		expect(result).toEqual({ requestId: "", sources: [], warnings: [], usage: [] });
	});

	it("throws ParallelApiError for a non-object payload", () => {
		expect(() => parseParallelSearchPayload("notrecord")).toThrow(
			"Parallel search returned an invalid response payload.",
		);
	});
});

describe("getParallelExtractContent", () => {
	const url = "https://doc.example";

	it("prefers the joined non-blank excerpts", () => {
		expect(getParallelExtractContent({ url, excerpts: ["  ", "x", "y"], fullContent: "full" })).toBe("x\n\ny");
	});

	it("falls back to trimmed fullContent when there are no usable excerpts", () => {
		expect(getParallelExtractContent({ url, excerpts: ["  ", ""], fullContent: "  full  " })).toBe("full");
	});

	it("returns an empty string when both excerpts and fullContent are empty", () => {
		expect(getParallelExtractContent({ url, excerpts: [] })).toBe("");
	});
});
