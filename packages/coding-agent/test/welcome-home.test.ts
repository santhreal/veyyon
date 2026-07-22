/**
 * Default welcome home (the screen every launch shows) — the 2026-07-22
 * improvement pass. Before it, the recent-session list was fetched on every
 * start yet rendered only behind /welcome, so the single most useful thing at
 * launch (continue where you left off) stayed hidden, and tips were equally
 * buried. The home now shows ONE continue line and ONE quiet tip, and nothing
 * else changed: the hero stays open space, no boxes, no panels.
 *
 * Locks:
 *  1. With a recent session: a centred continue line with the session name,
 *     its relative age, and the /resume affordance.
 *  2. The "more:" hint dedups /resume when the continue line already offers
 *     it, and keeps it when there is no recent session.
 *  3. A tip renders on the home (not only behind /welcome).
 *  4. No recent sessions → no continue line, no stray separators.
 *  5. Long session names truncate instead of shattering the centred column.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { WelcomeComponent } from "@veyyon/coding-agent/modes/components/welcome";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

function home(sessions: { name: string; timeAgo: string }[]): string {
	const welcome = new WelcomeComponent("1.2.3", "Sonnet 4.5", "anthropic", sessions);
	return welcome
		.render(100)
		.map(line => stripVTControlCharacters(line))
		.join("\n");
}

describe("welcome home screen", () => {
	beforeAll(() => {
		initTheme();
	});

	it("shows a continue line for the most recent session with the /resume affordance", () => {
		const frame = home([{ name: "detector policy work", timeAgo: "2h ago" }]);
		expect(frame).toContain("detector policy work · 2h ago — /resume");
	});

	it("dedups /resume out of the more-hint when the continue line offers it", () => {
		const frame = home([{ name: "detector policy work", timeAgo: "2h ago" }]);
		expect(frame).toContain("more: /welcome  ·  /settings");
		expect(frame).not.toContain("/welcome  ·  /resume");
	});

	it("keeps /resume in the more-hint when there is no session to continue", () => {
		const frame = home([]);
		expect(frame).toContain("more: /welcome  ·  /resume  ·  /settings");
	});

	it("renders a tip on the home screen", () => {
		expect(home([])).toContain("Tip:");
	});

	it("shows no continue line and no stray separator without recent sessions", () => {
		const frame = home([]);
		expect(frame).not.toContain(" — /resume");
		expect(frame).not.toContain(" ago");
	});

	/** Live-capture regression (2026-07-22, 120-col tmux): wrapped tips were
	 * centred PER LINE, so the final fragment ("just images") floated alone in
	 * mid-air and the hanging indent under "Tip: " was stripped. The tip must
	 * centre as one block: every continuation line starts exactly at the
	 * label-body column of the first line. */
	it("centres a wrapped tip as one block with the hanging indent intact", () => {
		// Tips are randomly picked; sample components until a wrapping tip shows.
		for (let attempt = 0; attempt < 60; attempt++) {
			const frameLines = home([]).split("\n");
			const tipIndex = frameLines.findIndex(line => line.includes("Tip:"));
			expect(tipIndex).toBeGreaterThan(-1);
			const tipLine = frameLines[tipIndex] as string;
			const bodyColumn = tipLine.indexOf("Tip:") + "Tip: ".length;
			const continuations: string[] = [];
			for (let i = tipIndex + 1; i < frameLines.length && (frameLines[i] as string).trim() !== ""; i++) {
				continuations.push(frameLines[i] as string);
			}
			if (continuations.length === 0) continue; // single-line tip — resample
			for (const line of continuations) {
				expect(line.length - line.trimStart().length).toBe(bodyColumn);
			}
			return;
		}
		throw new Error("expected at least one wrapping tip in 60 samples");
	});

	it("truncates a long session name instead of shattering the centred column", () => {
		const longName = "a".repeat(120);
		const frame = home([{ name: longName, timeAgo: "1d ago" }]);
		expect(frame).not.toContain(longName);
		expect(frame).toContain("— /resume");
		for (const line of frame.split("\n")) {
			expect(line.length).toBeLessThanOrEqual(100);
		}
	});
});
