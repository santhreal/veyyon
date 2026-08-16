import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
	applyModalReveal,
	computeModalDims,
	fitTipLine,
	hitTestModalChrome,
	MODAL_SIZING_LARGE,
	MODAL_SIZING_MEDIUM,
	MODAL_SIZING_SETTINGS,
	ModalRevealDriver,
	type ModalShellGeometry,
	type ModalShellResult,
	minModalChromeRows,
	renderModalShell,
	renderModalShortcuts,
	SETTINGS_BROWSE_SHORTCUTS,
	sizingForArea,
} from "@veyyon/coding-agent/modes/components/modal-shell";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { MotionClock } from "@veyyon/tui";

await initTheme(false, "unicode", false, "titanium", "light");

describe("ModalShell", () => {
	it("computes a floating card with margins, not edge-to-edge", () => {
		const dims = computeModalDims(120, 40, MODAL_SIZING_SETTINGS);
		expect(dims).not.toBeNull();
		expect(dims!.modalWidth).toBeLessThan(120);
		expect(dims!.modalHeight).toBe(40 - 2 * MODAL_SIZING_SETTINGS.vMargin);
		expect(dims!.leftPad).toBeGreaterThan(0);
		expect(dims!.topPad).toBeGreaterThan(0);
	});

	it("aborts when the terminal is too small", () => {
		expect(computeModalDims(18, 40, MODAL_SIZING_SETTINGS)).toBeNull();
		expect(computeModalDims(80, 5, MODAL_SIZING_SETTINGS)).toBeNull();
	});

	/**
	 * Compact sheds PADDING, and only padding.
	 *
	 * It used to zero `vMargin` as well, so a card that entered compact mode took
	 * the whole screen and then gave two whole margins back the moment it left,
	 * which is the height cliff pinned in
	 * `modes/components/modal-shell-height-is-monotonic.test.ts`: a 24-row
	 * terminal drew sixteen roster rows and a 25-row terminal drew none. The
	 * margin is the card's relationship to the screen and does not change with
	 * how tight the card is inside.
	 */
	it("sizingForArea strips the padding and keeps the margin", () => {
		const c = sizingForArea(MODAL_SIZING_SETTINGS, 10);
		expect(c.vMargin).toBe(MODAL_SIZING_SETTINGS.vMargin);
		expect(c.hPad).toBe(1);
		expect(c.vPad).toBe(0);
	});

	it("paints title, search, tip, and centered shortcut chips", () => {
		const { lines, geometry } = renderModalShell({
			title: "Settings",
			sizing: MODAL_SIZING_SETTINGS,
			areaWidth: 100,
			areaHeight: 30,
			body: ["  row one", "  row two"],
			searchLine: " / search settings",
			tipCandidates: ["Tip · Ask the agent to change a setting", "Tip · short"],
			shortcuts: SETTINGS_BROWSE_SHORTCUTS,
			showClose: true,
		});
		expect(geometry).not.toBeNull();
		const plain = lines.map(l => stripVTControlCharacters(l)).join("\n");
		expect(plain).toContain("Settings");
		expect(plain).toContain("[x]");
		expect(plain).toContain("/ search settings");
		expect(plain).toContain("Tip ·");
		expect(plain).toContain("esc close");
		expect(plain).toContain("enter change");
		// Floating: empty pad rows around the card.
		expect(lines[0]?.trim()).toBe("");
		expect(geometry!.bodyRowStart).toBeGreaterThan(0);
	});

	it("wraps footer chips and fits tip candidates", () => {
		const chips = renderModalShortcuts(SETTINGS_BROWSE_SHORTCUTS, 30);
		expect(chips.length).toBeGreaterThan(1);
		expect(fitTipLine(["a very long tip that will not fit in ten", "short tip"], 12)).toBe("short tip");
	});

	it("joins footer chips with the shared `·` grammar, never the legacy `|`", () => {
		// The whole TUI uses one separator dialect — the middle dot with two spaces
		// each side. Modal footers were the lone `|` holdout, which read as a
		// foreign dialect on the same screen. This locks the grammar so a `|`
		// separator cannot creep back into the chip band.
		const shortcuts = [
			{ label: "up/down select" },
			{ label: "enter confirm", clickable: true, id: "confirm" },
			{ label: "esc cancel", clickable: true, id: "close" },
		];
		const row = stripVTControlCharacters(renderModalShortcuts(shortcuts, 84)[0] ?? "");
		expect(row).toContain("  ·  ");
		expect(row).not.toContain("|");
		// The dot joins adjacent chips: exactly (n-1) separators for n chips.
		expect(row.split("  ·  ").length).toBe(shortcuts.length);
	});

	it("never strands a lone trailing chip on its own wrapped row", () => {
		// Regression: plan-review's "actions" footer at this width used to wrap
		// with 5 chips on row one and "esc cancel" alone on row two, looking
		// like an orphan versus the tight Grok-style chip band.
		const shortcuts = [
			{ label: "up/down select" },
			{ label: "enter confirm", clickable: true, id: "confirm" },
			{ label: "c copy" },
			{ label: "tab regions" },
			{ label: "ctrl+e editor" },
			{ label: "esc cancel", clickable: true, id: "close" },
		];
		const rows = renderModalShortcuts(shortcuts, 84).map(line => stripVTControlCharacters(line).trim());
		expect(rows.length).toBe(2);
		expect(rows[0]).not.toContain("esc cancel");
		// The trailing row must carry at least two chips, not a solitary one. Chips
		// are joined by the shared `·` separator (one grammar across the TUI).
		expect(rows[1]?.includes("·")).toBe(true);
		expect(rows[1]).toContain("esc cancel");
	});

	it("cascades the orphan-avoidance fix back through 3+ wrapped rows", () => {
		// Regression: a single-hop fix only rescues the trailing row when its
		// immediate predecessor can spare a chip without dropping below 2. At
		// this width SETTINGS_BROWSE_SHORTCUTS' first chip is too wide to share
		// a row, forcing 3 rows; the fix must ripple the deficiency all the way
		// back to row 0 instead of leaving a lone "esc close" on the last row.
		const rows = renderModalShortcuts(SETTINGS_BROWSE_SHORTCUTS, 28).map(line =>
			stripVTControlCharacters(line).trim(),
		);
		expect(rows.length).toBe(3);
		// No row after the first may be a solitary chip beneath a fuller row. A row
		// with the shared `·` separator carries two or more chips.
		for (let i = 1; i < rows.length; i++) {
			const soloChip = !rows[i]!.includes("·");
			expect(soloChip && rows[i - 1]!.includes("·")).toBe(false);
		}
		expect(rows.join(" ")).toContain("esc close");
	});

	it("never clips the bottom border or shortcut chips on a short terminal", () => {
		// A search + tip overlay whose chrome alone (search 2 + tip 2 + footer 4 +
		// borders 2) exceeds the modal height must shed the tip/pad, not shear off
		// the bottom border (regression: card.slice cut the last rows).
		const { lines, geometry } = renderModalShell({
			title: "Model Hub",
			sizing: MODAL_SIZING_LARGE,
			areaWidth: 80,
			areaHeight: 24,
			body: Array.from({ length: 8 }, (_, i) => `row ${i}`),
			searchLine: " / filter models",
			tipCandidates: ["Tip · type to filter"],
			shortcuts: [
				{ label: "up/down navigate" },
				{ label: "enter select", clickable: true, id: "confirm" },
				{ label: "esc close", clickable: true, id: "close" },
			],
			showClose: true,
		});
		expect(geometry).not.toBeNull();
		const painted = lines.filter(l => stripVTControlCharacters(l).trim().length > 0);
		const bottom = stripVTControlCharacters(painted[painted.length - 1] ?? "");
		// Bottom border row must be the sharp bottom-left/right corners, intact.
		expect(bottom).toContain("└");
		expect(bottom).toContain("┘");
		// The shortcut chips must still be present (never traded for the border).
		const plain = painted.map(l => stripVTControlCharacters(l)).join("\n");
		expect(plain).toContain("esc close");
		// And the card never exceeds the terminal height.
		expect(lines.length).toBe(24);
	});

	it("exposes clickable close and shortcut hit rects", () => {
		const { geometry } = renderModalShell({
			title: "Settings",
			sizing: MODAL_SIZING_SETTINGS,
			areaWidth: 100,
			areaHeight: 30,
			body: ["row"],
			shortcuts: SETTINGS_BROWSE_SHORTCUTS,
			showClose: true,
		});
		expect(geometry).not.toBeNull();
		expect(geometry!.closeColStart).toBeGreaterThan(0);
		expect(geometry!.shortcutHits.some(h => h.id === "close")).toBe(true);
		const close = hitTestModalChrome(geometry, geometry!.titleRow, geometry!.closeColStart + 1, {
			leftClick: true,
		});
		expect(close).toEqual({ kind: "close" });
		const outside = hitTestModalChrome(geometry, 0, 0, { leftClick: true });
		expect(outside).toEqual({ kind: "outside" });
	});
});

describe("applyModalReveal — the open unfold (TOUCH-5)", () => {
	// Why this suite exists: overlay open used to be a hard cut. The reveal
	// clips the rendered frame to an unfolding card (top border fixed, bottom
	// border sliding down) AND resolves the visible rows out of the ground, so
	// the first frame is not full-strength chrome with a moving edge. These
	// tests lock both halves: the clip can never leak partial card rows below
	// the moving border, paint a borderless sliver, or alter the settled frame,
	// and the fade can never touch a row outside the card or survive into the
	// settled frame.
	const GROUND = "#000000";

	function renderCard() {
		return renderModalShell({
			title: "Reveal",
			sizing: MODAL_SIZING_SETTINGS,
			areaWidth: 120,
			areaHeight: 40,
			body: Array.from({ length: 10 }, (_, i) => `row ${i}`),
			shortcuts: SETTINGS_BROWSE_SHORTCUTS,
		});
	}

	const plain = (line: string): string => stripVTControlCharacters(line);

	it("returns the frame byte-identical at reveal >= 1 (settled state)", () => {
		const shell = renderCard();
		expect(applyModalReveal(shell, 120, 1, GROUND)).toBe(shell.lines);
		expect(applyModalReveal(shell, 120, 2, GROUND)).toBe(shell.lines);
	});

	it("returns the frame untouched when the terminal was too small (null geometry)", () => {
		const shell = renderModalShell({
			title: "Tiny",
			sizing: MODAL_SIZING_SETTINGS,
			areaWidth: 18,
			areaHeight: 40,
			body: ["x"],
			shortcuts: [],
		});
		expect(shell.geometry).toBeNull();
		expect(applyModalReveal(shell, 18, 0.5, GROUND)).toBe(shell.lines);
	});

	it("keeps the top border fixed and slides the BOTTOM border up mid-reveal", () => {
		const shell = renderCard();
		const geometry = shell.geometry!;
		const clipped = applyModalReveal(shell, 120, 0.5, GROUND);
		// Same glyphs in the same columns as the settled frame; only the color
		// strength differs while the card is still arriving.
		expect(plain(clipped[geometry.cardRowStart]!)).toBe(plain(shell.lines[geometry.cardRowStart]!));
		// cardRowEnd is exclusive, matching hitTestModalChrome.
		const cardRows = geometry.cardRowEnd - geometry.cardRowStart;
		const visible = Math.max(2, Math.round(cardRows * 0.5));
		// The last visible row is the card's real bottom border, not a sheared body row.
		expect(plain(clipped[geometry.cardRowStart + visible - 1]!)).toBe(plain(shell.lines[geometry.cardRowEnd - 1]!));
		// Everything between the moved border and the settled border is blank.
		for (let row = geometry.cardRowStart + visible; row < geometry.cardRowEnd; row++) {
			expect(plain(clipped[row]!).trim()).toBe("");
		}
	});

	it("never shows a borderless sliver: reveal 0 still paints both border rows", () => {
		const shell = renderCard();
		const geometry = shell.geometry!;
		const clipped = applyModalReveal(shell, 120, 0, GROUND);
		expect(plain(clipped[geometry.cardRowStart]!)).toBe(plain(shell.lines[geometry.cardRowStart]!));
		expect(plain(clipped[geometry.cardRowStart + 1]!)).toBe(plain(shell.lines[geometry.cardRowEnd - 1]!));
	});

	// The theme in this process renders in whatever color mode the environment
	// reports, and an indexed frame has no channels to fade — a fade test over
	// the rendered card would pass by finding nothing. These two drive the same
	// production function over a truecolor frame built here, so the assertion
	// has something to be wrong about.
	function truecolorFrame(): ModalShellResult {
		const card = [
			"\x1b[38;2;200;200;200m┌── Reveal ──┐\x1b[0m",
			"\x1b[38;2;100;100;100m│ body       │\x1b[0m",
			"\x1b[38;2;100;100;100m│ body       │\x1b[0m",
			"\x1b[38;2;200;200;200m└────────────┘\x1b[0m",
		];
		const geometry = { cardRowStart: 1, cardRowEnd: 5 } as ModalShellGeometry;
		return { lines: ["above", ...card, "below"], geometry };
	}

	it("resolves the card out of the ground: no truecolor channel is lit at reveal 0", () => {
		const frame = truecolorFrame();
		const clipped = applyModalReveal(frame, 40, 0, GROUND);
		for (const row of [1, 2]) {
			const channels = [...clipped[row]!.matchAll(/[34]8;2;(\d+);(\d+);(\d+)/g)];
			expect(channels.length).toBeGreaterThan(0);
			for (const [, r, g, b] of channels) expect(`${r},${g},${b}`).toBe("0,0,0");
		}
		// Glyphs are still there; the card resolves out of the ground rather
		// than arriving as empty rows that later fill in.
		expect(plain(clipped[1]!)).toBe("┌── Reveal ──┐");
		expect(plain(clipped[2]!)).toBe("└────────────┘");
	});

	it("brightens monotonically toward the settled color", () => {
		const frame = truecolorFrame();
		const firstChannel = (line: string): number => {
			const match = /[34]8;2;(\d+);/.exec(line);
			return match === null ? -1 : Number(match[1]);
		};
		let previous = -1;
		for (const reveal of [0, 0.25, 0.5, 0.75]) {
			const value = firstChannel(applyModalReveal(frame, 40, reveal, GROUND)[1]!);
			expect(value).toBeGreaterThan(previous);
			expect(value).toBeLessThan(200);
			previous = value;
		}
		// Settled is the untouched frame at full strength.
		expect(applyModalReveal(frame, 40, 1, GROUND)).toBe(frame.lines);
	});

	it("grows monotonically: a larger reveal never shows fewer card rows", () => {
		const shell = renderCard();
		const geometry = shell.geometry!;
		const visibleRows = (reveal: number): number => {
			const clipped = applyModalReveal(shell, 120, reveal, GROUND);
			let count = 0;
			for (let row = geometry.cardRowStart; row < geometry.cardRowEnd; row++) {
				if (plain(clipped[row]!).trim() !== "") count++;
			}
			return count;
		};
		let previous = 0;
		for (const reveal of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
			const current = visibleRows(reveal);
			expect(current).toBeGreaterThanOrEqual(previous);
			previous = current;
		}
		// Settled: every card row that is non-blank in the full frame is shown.
		let settled = 0;
		for (let row = geometry.cardRowStart; row < geometry.cardRowEnd; row++) {
			if (plain(shell.lines[row]!).trim() !== "") settled++;
		}
		expect(previous).toBe(settled);
	});

	it("leaves rows outside the card region untouched at every phase", () => {
		const shell = renderCard();
		const geometry = shell.geometry!;
		for (const reveal of [0, 0.3, 0.7]) {
			const clipped = applyModalReveal(shell, 120, reveal, GROUND);
			for (let row = 0; row < geometry.cardRowStart; row++) {
				expect(clipped[row]).toBe(shell.lines[row]!);
			}
			for (let row = geometry.cardRowEnd; row < shell.lines.length; row++) {
				expect(clipped[row]).toBe(shell.lines[row]!);
			}
		}
	});
});

describe("ModalRevealDriver — the phase driver on the shared clock", () => {
	// Why: the driver is the only stateful piece of the unfold, and it is now
	// one of many animations on a single clock rather than an interval of its
	// own. These tests lock its lifecycle so a settled overlay can never keep
	// requesting renders, a dismounted card can never ask a disposed component
	// to repaint, and a started reveal always begins collapsed instead of
	// flashing the full card first. Frames are driven by hand: a driver test
	// that sleeps on a real timer is a driver test that flakes.
	const FRAME = 1000 / 60;

	function driveToSettle(clock: MotionClock, limit = 200): number {
		for (let i = 1; i <= limit; i++) {
			clock.tick(i * FRAME);
			if (clock.liveCount === 0) return i;
		}
		return limit + 1;
	}

	it("reports 1 before start (a never-animated card renders settled)", () => {
		const driver = new ModalRevealDriver(new MotionClock());
		expect(driver.value).toBe(1);
	});

	it("starts collapsed, ticks renders, then settles at exactly 1 and stops ticking", () => {
		const clock = new MotionClock();
		const driver = new ModalRevealDriver(clock);
		let ticks = 0;
		driver.start(() => {
			ticks++;
		});
		expect(ticks).toBe(1); // first paint requested synchronously
		expect(driver.value).toBe(0); // the timeline anchors on that first paint
		clock.tick(FRAME);
		expect(driver.value).toBeLessThan(0.7);

		driveToSettle(clock);
		expect(driver.value).toBe(1);
		const settledTicks = ticks;
		clock.tick(10_000);
		expect(ticks).toBe(settledTicks); // dropped from the clock; no leak
	});

	it("stop() settles immediately mid-flight and stops asking for renders", () => {
		const clock = new MotionClock();
		const driver = new ModalRevealDriver(clock);
		let ticks = 0;
		driver.start(() => {
			ticks++;
		});
		void driver.value;
		clock.tick(FRAME);
		const beforeStop = ticks;
		driver.stop();
		expect(driver.value).toBe(1);
		clock.tick(2 * FRAME);
		clock.tick(3 * FRAME);
		// A dismounted card repainting is the leak this guards; the count must
		// not move, and the clock must have forgotten the animation entirely.
		expect(ticks).toBe(beforeStop);
		expect(clock.liveCount).toBe(0);
	});
});

/**
 * The chrome floor a caller can size a layout against.
 *
 * `ask-dialog.ts` needs the body budget BEFORE rendering, to decide between a
 * side-by-side preview and a stacked list, and it used to restate the shell's
 * arithmetic as `3 + footerLines + vPad` with a comment admitting it mirrored an
 * internal calculation. A restated formula silently stops matching the moment the
 * shell grows or drops a row, and the symptom would be a layout decision made
 * against a budget the renderer does not honour: a preview column chosen for a
 * card that cannot hold it. So the terms live in the shell, and these tests tie
 * the exported number to what the renderer actually reserves rather than to a
 * second copy of the same sum.
 */
describe("minModalChromeRows", () => {
	/** The floor, per sizing, named term by term. A change to `vPad` or
	 *  `footerLines` must move it; a change to the borders must move it too.
	 *
	 *  `vPad` is charged TWICE, once above the body and once below it. It used to
	 *  be charged only above, which nothing showed while every card was full
	 *  height and padded out with filler rows; once a card hugs its content the
	 *  last row rests directly on the footer divider, so the pad is now symmetric
	 *  and the budget a caller sizes a layout against has to say so. */
	it.each([
		[MODAL_SIZING_LARGE, 9],
		[MODAL_SIZING_MEDIUM, 7],
		[MODAL_SIZING_SETTINGS, 7],
	])("counts top border, both vPad bands, divider, footer band, and bottom border", (sizing, expected) => {
		expect(minModalChromeRows(sizing)).toBe(expected);
		expect(minModalChromeRows(sizing)).toBe(3 + 2 * sizing.vPad + sizing.footerLines);
	});

	/** THE drift lock. With nothing droppable in play (no search line, no tip, and
	 *  shortcut chips that fit inside `footerLines` on one row), the rows the
	 *  renderer spends outside the body must equal the floor exactly. If the shell
	 *  gains or loses a border, divider, or pad row, this fails and the caller's
	 *  budget is corrected with it. Measured from the rendered card, not recomputed. */
	it("equals the rows the renderer actually spends outside the body", () => {
		for (const sizing of [MODAL_SIZING_LARGE, MODAL_SIZING_MEDIUM, MODAL_SIZING_SETTINGS]) {
			const body = Array.from({ length: 40 }, (_, i) => `  row ${i}`);
			const areaHeight = 40;
			const { lines, geometry } = renderModalShell({
				title: "Card",
				sizing,
				areaWidth: 120,
				areaHeight,
				body,
				shortcuts: [{ label: "esc close" }],
			});
			expect(geometry).not.toBeNull();

			expect(geometry!.modalHeight - geometry!.bodyRowCount).toBe(minModalChromeRows(sizing));
			// The geometry is only trustworthy if it describes the frame that was
			// actually produced. The render must fill the area it was handed exactly,
			// and the card it reports must fit inside that area: a chrome row spent
			// past the edge would still satisfy the arithmetic above while clipping.
			expect(lines.length).toBe(areaHeight);
			expect(geometry!.modalHeight).toBeLessThanOrEqual(areaHeight);
		}
	});

	/** The floor is a floor: a search line adds two rows, so a caller using it as
	 *  an exact budget would be wrong in the direction that overfills the card.
	 *  Stated as a test so the docstring's claim is checked, not just asserted. */
	it("is a minimum, and a search line costs more than it", () => {
		const withoutSearch = renderModalShell({
			title: "Card",
			sizing: MODAL_SIZING_LARGE,
			areaWidth: 120,
			areaHeight: 40,
			body: Array.from({ length: 40 }, (_, i) => `  row ${i}`),
			shortcuts: [{ label: "esc close" }],
		});
		const withSearch = renderModalShell({
			title: "Card",
			sizing: MODAL_SIZING_LARGE,
			areaWidth: 120,
			areaHeight: 40,
			body: Array.from({ length: 40 }, (_, i) => `  row ${i}`),
			searchLine: " / find",
			shortcuts: [{ label: "esc close" }],
		});

		expect(withoutSearch.geometry!.bodyRowCount - withSearch.geometry!.bodyRowCount).toBe(2);
		expect(withSearch.geometry!.modalHeight - withSearch.geometry!.bodyRowCount).toBe(
			minModalChromeRows(MODAL_SIZING_LARGE) + 2,
		);
	});
});
