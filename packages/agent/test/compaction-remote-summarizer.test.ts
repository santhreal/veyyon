import { describe, expect, test } from "bun:test";
import { requestRemoteCompaction } from "@veyyon/agent-core/compaction/remote-summarizer";

/**
 * `compaction.remoteEndpoint` points at whatever the operator configured, so
 * both of these are the misconfiguration path rather than an exotic one:
 *
 * - A non-2xx body that is not a summarizer error envelope (proxy page, captive
 *   portal, plain web server). Uncapped, the whole page was written to
 *   `~/.veyyon/logs` on every compaction attempt of every turn.
 * - A 200 response whose summary is blank. The summary REPLACES the history it
 *   summarizes, so accepting one deletes the conversation and reports success.
 *   The local summarizer in `generateSummary` already refuses; the remote
 *   transport did not, and `generateSummary` returns `remote.summary` without
 *   re-checking it.
 */
const ENDPOINT = "https://summarizer.example/summarize";
const CHAT_ENDPOINT = "https://summarizer.example/v1/chat/completions";
const REQUEST = { systemPrompt: "sp", prompt: "p" };

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("requestRemoteCompaction error-body bound", () => {
	test("caps a huge non-2xx body at 4096 chars and reports the original length", async () => {
		const page = "<html>".repeat(20_000);
		let handedToSanitizer: string | undefined;

		await expect(
			requestRemoteCompaction(ENDPOINT, REQUEST, undefined, {
				fetch: async () => new Response(page, { status: 502, statusText: "Bad Gateway" }),
				sanitizeErrorText: text => {
					// The redactor is the last hop before the log line, so what it
					// receives is exactly what would have been written.
					if (handedToSanitizer === undefined) handedToSanitizer = text;
					return text;
				},
			}),
		).rejects.toThrow("Remote compaction failed (502 Bad Gateway)");

		expect(page.length).toBe(120_000);
		expect(handedToSanitizer).toBe(`${page.slice(0, 4096)} [truncated, 120000 chars total]`);
		expect(handedToSanitizer?.length).toBe(4096 + " [truncated, 120000 chars total]".length);
	});

	test("leaves a body at the cap untouched, so short errors keep every byte", async () => {
		const body = "e".repeat(4096);
		let handedToSanitizer: string | undefined;

		await expect(
			requestRemoteCompaction(ENDPOINT, REQUEST, undefined, {
				fetch: async () => new Response(body, { status: 500, statusText: "Server Error" }),
				sanitizeErrorText: text => {
					if (handedToSanitizer === undefined) handedToSanitizer = text;
					return text;
				},
			}),
		).rejects.toThrow("Remote compaction failed (500 Server Error)");

		expect(handedToSanitizer).toBe(body);
	});
});

describe("requestRemoteCompaction empty-summary refusal", () => {
	test("a whitespace-only `summary` is refused, not returned as the new history", async () => {
		await expect(
			requestRemoteCompaction(ENDPOINT, REQUEST, undefined, {
				fetch: async () => jsonResponse({ summary: " \n\t " }),
			}),
		).rejects.toThrow("Remote compaction returned no usable summary text. The history was NOT compacted.");
	});

	test("an absent `summary` is refused with the same message as a blank one", async () => {
		await expect(
			requestRemoteCompaction(ENDPOINT, REQUEST, undefined, {
				fetch: async () => jsonResponse({ notSummary: "x" }),
			}),
		).rejects.toThrow("Remote compaction returned no usable summary text. The history was NOT compacted.");
	});

	test("real summary text passes through byte for byte, including its surrounding whitespace", async () => {
		const result = await requestRemoteCompaction(ENDPOINT, REQUEST, undefined, {
			fetch: async () => jsonResponse({ summary: "  ## Goal\nShip it.  ", shortSummary: "ship" }),
		});

		expect(result).toEqual({ summary: "  ## Goal\nShip it.  ", shortSummary: "ship" });
	});

	test("chat-completions: whitespace-only content is refused", async () => {
		await expect(
			requestRemoteCompaction(CHAT_ENDPOINT, REQUEST, undefined, {
				fetch: async () => jsonResponse({ choices: [{ message: { content: "   " } }] }),
			}),
		).rejects.toThrow("Remote compaction returned an empty summary in choices[0].message.content.");
	});

	test("chat-completions: block content is joined and returned", async () => {
		const result = await requestRemoteCompaction(CHAT_ENDPOINT, REQUEST, undefined, {
			fetch: async () =>
				jsonResponse({ choices: [{ message: { content: [{ text: "## Goal\n" }, { text: "Ship." }] } }] }),
		});

		expect(result).toEqual({ summary: "## Goal\nShip." });
	});
});
