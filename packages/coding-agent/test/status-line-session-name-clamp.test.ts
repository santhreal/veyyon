/**
 * Footline session-name chip clamp.
 *
 * Why this suite exists: sessions auto-title from the first user message, so
 * the name is often sentence-length ("Render check line second paragraph").
 * The session_name segment rendered it unclamped, letting one chip dominate
 * the footline that model, mode, path, git, and the context bar all share
 * (live find 2026-07-22). The chip now clamps to TRUNCATE_LENGTHS.CHIP with
 * an ellipsis; short names render byte-for-byte as before.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { renderSegment, type SegmentContext } from "@veyyon/coding-agent/modes/components/status-line/segments";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { TRUNCATE_LENGTHS } from "@veyyon/coding-agent/tools/render-utils";
import { stripAnsi } from "@veyyon/utils";

function ctxWithSessionName(name: string): SegmentContext {
	return { session: { sessionManager: { getSessionName: () => name } } } as unknown as SegmentContext;
}

describe("session_name footline chip", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	/** A short, deliberate session name must render whole — the clamp exists
	 * for runaway auto-titles, not for names an operator chose. */
	it("renders short names unclamped", () => {
		const rendered = renderSegment("session_name", ctxWithSessionName("bugfix"));
		expect(rendered.visible).toBe(true);
		expect(stripAnsi(rendered.content)).toBe("bugfix");
	});

	/** The regression: a sentence-length auto-title must clamp to the CHIP
	 * budget (ellipsis included), never render its full width. */
	it("clamps sentence-length auto-titles to the CHIP budget", () => {
		const long = "Render check line second paragraph and then some more words";
		const rendered = renderSegment("session_name", ctxWithSessionName(long));
		const visible = stripAnsi(rendered.content);
		expect(visible.length).toBeLessThanOrEqual(TRUNCATE_LENGTHS.CHIP);
		expect(visible.endsWith("…")).toBe(true);
		expect(visible.startsWith("Render check line")).toBe(true);
	});

	/** No name → the segment stays hidden, exactly as before. */
	it("stays hidden when the session has no name", () => {
		const rendered = renderSegment("session_name", ctxWithSessionName(""));
		expect(rendered.visible).toBe(false);
	});
});
