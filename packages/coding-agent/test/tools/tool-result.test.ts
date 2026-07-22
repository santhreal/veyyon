import { describe, expect, it } from "bun:test";

import type { AgentToolResult } from "@veyyon/agent-core";
import { prependResultNotice } from "@veyyon/coding-agent/tools/tool-result";

// `prependResultNotice` is the ONE-PLACE injector that four tools (ssh, lsp,
// debug, browser) use to surface a clamped-timeout notice on a result their
// per-action code already built. A bug here is a Law-10 bug in every one of
// them: the notice would be dropped, mangled, or would clobber the real output.
// It is pure and native-free, so each contract below is pinned with real values.

type Details = { meta?: undefined; tag?: string };

describe("prependResultNotice", () => {
	// The common case: a result whose first block is text. The notice must land
	// ahead of that text, separated by a blank line, and must not spawn a second
	// text block (which some consumers render as a separate message).
	it("prepends the notice to the first text block, keeping a single block", () => {
		const result: AgentToolResult<Details> = {
			content: [{ type: "text", text: "command output" }],
		};

		const out = prependResultNotice(result, "Timeout clamped to 5s.");

		expect(out.content).toEqual([{ type: "text", text: "Timeout clamped to 5s.\n\ncommand output" }]);
	});

	// A result may have no text block at all (for example an image-only browser
	// screenshot). The notice must still reach the agent, so it is inserted as a
	// new leading text block rather than being silently discarded.
	it("inserts a leading text block when the result has no text", () => {
		const result: AgentToolResult<Details> = {
			content: [{ type: "image", data: "deadbeef", mimeType: "image/png" }],
		};

		const out = prependResultNotice(result, "Timeout clamped to 300s.");

		expect(out.content).toEqual([
			{ type: "text", text: "Timeout clamped to 300s." },
			{ type: "image", data: "deadbeef", mimeType: "image/png" },
		]);
	});

	// When text is not the first block, the notice attaches to the first *text*
	// block found, never to an image, so it reads as a prefix of the message the
	// agent sees, and the leading image is left in place.
	it("targets the first text block even when it is not first in content", () => {
		const result: AgentToolResult<Details> = {
			content: [
				{ type: "image", data: "aa", mimeType: "image/png" },
				{ type: "text", text: "second block" },
			],
		};

		const out = prependResultNotice(result, "note");

		expect(out.content).toEqual([
			{ type: "image", data: "aa", mimeType: "image/png" },
			{ type: "text", text: "note\n\nsecond block" },
		]);
	});

	// The injector adorns output only. It must carry through details, isError,
	// and useless untouched, or a clamped timeout on a failing call would quietly
	// flip the result's error/compaction semantics.
	it("preserves details, isError, and useless flags unchanged", () => {
		const result: AgentToolResult<Details> = {
			content: [{ type: "text", text: "boom" }],
			details: { tag: "kept" },
			isError: true,
			useless: true,
		};

		const out = prependResultNotice(result, "note");

		expect(out.details).toEqual({ tag: "kept" });
		expect(out.isError).toBe(true);
		expect(out.useless).toBe(true);
	});

	// It returns a new result and does not mutate the caller's object or its
	// content array, so a shared/streamed result cannot be corrupted in place.
	it("does not mutate the input result or its content array", () => {
		const original: AgentToolResult<Details> = {
			content: [{ type: "text", text: "original" }],
		};

		prependResultNotice(original, "note");

		expect(original.content).toEqual([{ type: "text", text: "original" }]);
	});
});
