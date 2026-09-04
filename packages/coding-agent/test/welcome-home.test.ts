/**
 * The two welcome surfaces: the hero every launch shows, and the fuller screen `/welcome` opens.
 *
 * The hero carried a most-recent-session line, and it arrived with the asynchronous session list
 * rather than with the frame, so the block grew a row under a composer that had already been drawn.
 * Recent sessions now live on `/welcome`, which is opened deliberately and can afford to wait for
 * them, and the hero is the header, one hint line naming the commands, and one tip.
 *
 * Locks:
 *  1. The hero's hint line is the same bytes with recent sessions and without, since a hint that
 *     changed with the list would reintroduce the late repaint by another route.
 *  2. The hero names no session: no age, no `/resume` affordance beside a name.
 *  3. A tip renders on the hero, not only behind `/welcome`, and a wrapped tip centres as a block.
 *  4. `/welcome` lists the recent sessions under a Recent heading, most recent first.
 *  5. A long session name is truncated to the menu column rather than shattering it.
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
	// Awaited: `initTheme` is async, and every cell here renders through the resolved theme. The
	// unawaited call left the palette unset for whichever cell ran first, which throws on
	// `isLight` — the ordering that hid it is the runtime's, not this suite's to bet on.
	beforeAll(async () => {
		await initTheme();
	});

	/**
	 * The hint is a constant. It was computed from the session list — `/resume` was dropped from it
	 * when a continue line above already offered one — so the line changed the moment the
	 * asynchronous list landed. Identical bytes is the assertion, not merely "contains /resume".
	 */
	it("names the same commands whether or not there is a session to continue", () => {
		const withSession = home([{ name: "detector policy work", timeAgo: "2h ago" }]);
		const withNone = home([]);
		const hintOf = (frame: string): string | undefined => frame.split("\n").find(line => line.includes("more:"));

		expect(hintOf(withNone)).toContain("more: /welcome  ·  /resume  ·  /settings");
		expect(hintOf(withSession)).toBe(hintOf(withNone));
	});

	/** The hero names no session at all: not the name, not the age, not a resume affordance. */
	it("names no recent session on the hero", () => {
		const frame = home([{ name: "detector policy work", timeAgo: "2h ago" }]);

		expect(frame).not.toContain("detector policy work");
		expect(frame).not.toContain("2h ago");
		expect(frame).not.toContain("— /resume");
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

	it("lists the recent sessions on /welcome, most recent first", () => {
		const frame = welcomeScreen([
			{ name: "detector policy work", timeAgo: "2h ago" },
			{ name: "launch card facts", timeAgo: "1d ago" },
		]);
		const lines = frame.split("\n");
		const recent = lines.findIndex(line => line.includes("Recent"));

		expect(recent).toBeGreaterThan(-1);
		expect(lines.slice(recent).join("\n")).toContain("detector policy work");
		expect(lines.findIndex(line => line.includes("detector policy work"))).toBeLessThan(
			lines.findIndex(line => line.includes("launch card facts")),
		);
	});

	/**
	 * The column holds a fixed number of rows, so a long history cannot push the menu off the
	 * screen. The cap is the component's own constant rather than a number repeated here.
	 */
	it("lists no more sessions on /welcome than the column has slots", () => {
		const sessions = ["newest", "second", "third", "fourth", "fifth", "sixth", "seventh"].map((name, index) => ({
			name,
			timeAgo: `${index + 1}h ago`,
		}));
		const frame = welcomeScreen(sessions);
		const listed = sessions.filter(session => frame.includes(session.name)).map(session => session.name);

		expect(listed).toEqual(sessions.slice(0, WELCOME_SESSION_SLOTS).map(session => session.name));
	});

	it("truncates a long session name instead of shattering the centred column", () => {
		const longName = "a".repeat(120);
		const frame = welcomeScreen([{ name: longName, timeAgo: "1d ago" }]);

		expect(frame).not.toContain(longName);
		expect(frame).toContain("1d ago");
		for (const line of frame.split("\n")) {
			expect(line.length).toBeLessThanOrEqual(WIDTH);
		}
	});
});
