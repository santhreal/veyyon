/**
 * Default welcome home (the screen every launch shows) and the `/welcome` screen behind it.
 *
 * Locks:
 *  1. The launch hero carries the hint line and a tip, and NO recent-session row, whatever
 *     sessions it was handed. The row used to be here and was removed: it arrived with the
 *     asynchronous session list rather than with the frame, so the block it sat in changed
 *     height after the composer had already been drawn under it. A test that expects it back
 *     is asserting the reflow.
 *  2. The hint line therefore always offers `/resume`, because nothing else on the hero does.
 *  3. A tip renders on the home, not only behind `/welcome`, and a wrapped tip centres as one
 *     block with its hanging indent intact.
 *  4. `/welcome` is where the recent sessions live, as a `Recent` column, and a long session
 *     name truncates there instead of shattering the centred column.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
	WELCOME_SESSION_SLOTS,
	WelcomeComponent,
} from "@veyyon/coding-agent/modes/terminal/components/dialogs/welcome";
import { initTheme } from "@veyyon/coding-agent/theme/theme";

const WIDTH = 100;

/** The launch hero: the screen a start paints, before anyone asks for `/welcome`. */
function home(sessions: { name: string; timeAgo: string }[]): string {
	return frameOf(new WelcomeComponent("1.2.3", "Sonnet 4.5", "anthropic", sessions));
}

/** The `/welcome` screen: the sunrise header plus the menu and `Recent` column. */
function welcomeScreen(sessions: { name: string; timeAgo: string }[]): string {
	return frameOf(new WelcomeComponent("1.2.3", "Sonnet 4.5", "anthropic", sessions, [], true));
}

function frameOf(welcome: WelcomeComponent): string {
	return welcome
		.render(WIDTH)
		.map(line => stripVTControlCharacters(line))
		.join("\n");
}

describe("welcome home screen", () => {
	beforeAll(() => {
		initTheme();
	});

	it("shows no recent-session row on the launch hero, whatever sessions it was handed", () => {
		const frame = home([{ name: "detector policy work", timeAgo: "2h ago" }]);
		expect(frame).not.toContain("detector policy work");
		expect(frame).not.toContain("2h ago");
	});

	it("offers /resume in the hint line, which is the only place the hero offers it", () => {
		const withSession = home([{ name: "detector policy work", timeAgo: "2h ago" }]);
		const withNone = home([]);
		expect(withSession).toContain("more: /welcome  ·  /resume  ·  /settings");
		expect(withNone).toContain("more: /welcome  ·  /resume  ·  /settings");
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

	it("lists the recent sessions on /welcome, newest first and no more than the slots", () => {
		const sessions = ["newest", "middle", "older", "oldest"].map((name, index) => ({
			name,
			timeAgo: `${index + 1}h ago`,
		}));
		const frame = welcomeScreen(sessions);

		expect(frame).toContain("Recent");
		const listed = sessions.filter(session => frame.includes(session.name)).map(session => session.name);
		expect(listed).toEqual(sessions.slice(0, WELCOME_SESSION_SLOTS).map(session => session.name));
	});

	it("truncates a long session name on /welcome instead of shattering the centred column", () => {
		const longName = "a".repeat(120);
		const frame = welcomeScreen([{ name: longName, timeAgo: "1d ago" }]);

		expect(frame).not.toContain(longName);
		expect(frame).toContain("1d ago");
		for (const line of frame.split("\n")) {
			expect(line.length).toBeLessThanOrEqual(WIDTH);
		}
	});
});
