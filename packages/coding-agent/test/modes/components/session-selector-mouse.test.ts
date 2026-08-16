import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { SessionSelectorComponent } from "@veyyon/coding-agent/modes/components/session-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { SessionInfo } from "@veyyon/coding-agent/session/session-listing";

beforeAll(async () => {
	await initTheme();
});

function plain(line: string): string {
	return stripVTControlCharacters(line);
}

function footerChipRow(lines: readonly string[]): number {
	return lines.findIndex(line => /esc close/i.test(plain(line)));
}
function makeSession(id: string, title: string | undefined): SessionInfo {
	return {
		path: `/work/${id}.jsonl`,
		id,
		cwd: "/work",
		title,
		created: new Date("2024-01-01T00:00:00Z"),
		modified: new Date("2024-01-02T00:00:00Z"),
		messageCount: 1,
		size: 1024,
		firstMessage: `body for ${id}`,
		allMessagesText: `body for ${id}`,
	};
}

/** SGR left-button press at a 1-based screen row (column must land inside the floating card). */
function leftClick(row1Based: number, col1Based = 20): string {
	return `\x1b[<0;${col1Based};${row1Based}M`;
}

/** SGR wheel notch: button 64 = up, 65 = down. */
function wheel(direction: "up" | "down"): string {
	return `\x1b[<${direction === "down" ? 65 : 64};1;1M`;
}

function makeSelector(
	sessions: SessionInfo[],
	onSelect: (s: SessionInfo) => void,
	rows = 40,
): SessionSelectorComponent {
	return new SessionSelectorComponent(
		sessions,
		onSelect,
		() => {},
		() => {},
		{
			getTerminalRows: () => rows,
			fillHeight: true,
		},
	);
}

describe("SessionSelectorComponent mouse", () => {
	it("resumes the session under a left click", () => {
		const sessions = [
			makeSession("aaaa", "Alpha session"),
			makeSession("bbbb", "Beta session"),
			makeSession("cccc", "Gamma session"),
		];
		let picked: SessionInfo | undefined;
		const selector = makeSelector(sessions, s => {
			picked = s;
		});

		// Render first so the hit-test map and list offset reflect this frame.
		const lines = selector.render(80);
		const betaRow = lines.findIndex(line => line.includes("Beta session"));
		expect(betaRow).toBeGreaterThanOrEqual(0);

		// Mouse rows are 1-based; the fullscreen overlay paints from screen row 0.
		selector.handleInput(leftClick(betaRow + 1));
		expect(picked?.id).toBe("bbbb");
	});

	it("scrolls the selection with the wheel, then resumes it on Enter", () => {
		const sessions = [
			makeSession("aaaa", "Alpha session"),
			makeSession("bbbb", "Beta session"),
			makeSession("cccc", "Gamma session"),
		];
		let picked: SessionInfo | undefined;
		const selector = makeSelector(sessions, s => {
			picked = s;
		});

		selector.render(80);
		// Selection starts at the first row; two notches down lands on Gamma.
		selector.handleInput(wheel("down"));
		selector.handleInput(wheel("down"));
		selector.handleInput("\n");
		expect(picked?.id).toBe("cccc");
	});

	it("ignores a click on the pinned footer (never resumes a hidden session)", () => {
		const sessions = Array.from({ length: 20 }, (_, i) => makeSession(`s${i}`, `Title ${i}`));
		let picked: SessionInfo | undefined;
		const selector = makeSelector(
			sessions,
			s => {
				picked = s;
			},
			40,
		);

		const lines = selector.render(80);
		const footerRow = footerChipRow(lines);
		expect(footerRow).toBeGreaterThanOrEqual(0);

		// Click the footer band away from clickable chips (left content gutter).
		selector.handleInput(leftClick(footerRow + 1, 8));
		expect(picked).toBeUndefined();
	});
});

describe("SessionSelectorComponent fill-height footer", () => {
	// First half titled (4 rows each), second half untitled (3 rows each), so the
	// scrolled window changes height — the regression that made the footer drift.
	function mixedSessions(count: number): SessionInfo[] {
		return Array.from({ length: count }, (_, i) => makeSession(`s${i}`, i < count / 2 ? `Titled ${i}` : undefined));
	}

	it("fills the viewport and keeps footer chips stable regardless of scroll", () => {
		const rows = 40;
		const selector = makeSelector(mixedSessions(20), () => {}, rows);

		const top = selector.render(80);
		const topHint = footerChipRow(top);
		expect(top.length).toBe(rows);
		expect(topHint).toBeGreaterThan(0);
		// Floating ModalShell: empty pad above the card.
		expect(top[0]!.trim()).toBe("");

		// Scroll to the bottom of the list; the footer chips must not move.
		for (let i = 0; i < 25; i++) selector.handleInput(wheel("down"));
		const bottom = selector.render(80);
		const bottomHint = footerChipRow(bottom);
		expect(bottom.length).toBe(rows);
		expect(bottomHint).toBe(topHint);
	});
});

/**
 * The delete confirmation is the embedded hook selector: it draws no card and
 * routes no mouse of its own, so every gesture over it has to be carried by the
 * picker, in the picker's coordinates. A confirmation that answers the keyboard
 * and ignores the pointer is the half-converted state this pins shut.
 */
describe("SessionSelectorComponent delete confirmation pointer", () => {
	function openConfirmation(onDelete: (session: SessionInfo) => Promise<boolean>) {
		const selector = new SessionSelectorComponent(
			[makeSession("aaaa", "Alpha session"), makeSession("bbbb", "Beta session")],
			() => {},
			() => {},
			() => {},
			{ onDelete, getTerminalRows: () => 40, fillHeight: true },
		);
		selector.handleInput("\x1b[3~");
		const lines = selector.render(80).map(plain);
		expect(lines.some(line => line.includes("Delete session?"))).toBe(true);
		return { selector, lines };
	}

	it("deletes on a click on Yes and closes the dialog", async () => {
		let deleted = 0;
		const { selector, lines } = openConfirmation(async () => {
			deleted += 1;
			return true;
		});
		const yesRow = lines.findIndex(line => line.includes("Yes"));
		expect(yesRow).toBeGreaterThanOrEqual(0);

		selector.handleInput(leftClick(yesRow + 1));
		await Bun.sleep(0);

		expect(deleted).toBe(1);
		const after = selector.render(80).map(plain);
		expect(after.some(line => line.includes("Delete session?"))).toBe(false);
		expect(after.some(line => line.includes("Alpha session"))).toBe(false);
	});

	it("keeps the session on a click on No, and the picker stays open", async () => {
		let deleted = 0;
		const { selector, lines } = openConfirmation(async () => {
			deleted += 1;
			return true;
		});
		const noRow = lines.findIndex(line => /^\s*[^A-Za-z]*No\b/.test(line));
		expect(noRow).toBeGreaterThanOrEqual(0);

		selector.handleInput(leftClick(noRow + 1));
		await Bun.sleep(0);

		expect(deleted).toBe(0);
		const after = selector.render(80).map(plain);
		expect(after.some(line => line.includes("Delete session?"))).toBe(false);
		expect(after.some(line => line.includes("Alpha session"))).toBe(true);
	});

	it("moves the dialog's cursor with the wheel rather than the list under it", async () => {
		let deleted = 0;
		const { selector } = openConfirmation(async () => {
			deleted += 1;
			return true;
		});

		// The cursor starts on "No"; one notch up lands on "Yes".
		selector.handleInput(wheel("up"));
		selector.handleInput("\n");
		await Bun.sleep(0);

		expect(deleted).toBe(1);
	});

	it("closes the dialog, not the picker, when the pointer cancels", async () => {
		let cancelledPicker = 0;
		const selector = new SessionSelectorComponent(
			[makeSession("aaaa", "Alpha session")],
			() => {},
			() => {
				cancelledPicker += 1;
			},
			() => {},
			{ onDelete: async () => true, getTerminalRows: () => 40, fillHeight: true },
		);
		selector.handleInput("\x1b[3~");
		selector.render(80);

		// Row 1 column 1 is outside the floating card.
		selector.handleInput(leftClick(1, 1));
		await Bun.sleep(0);

		expect(cancelledPicker).toBe(0);
		const after = selector.render(80).map(plain);
		expect(after.some(line => line.includes("Delete session?"))).toBe(false);
		expect(after.some(line => line.includes("Alpha session"))).toBe(true);
	});
});
