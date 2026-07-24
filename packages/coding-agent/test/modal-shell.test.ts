import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
	applyModalReveal,
	computeModalDims,
	fitTipLine,
	hitTestModalChrome,
	MODAL_SIZING_LARGE,
	MODAL_SIZING_SETTINGS,
	ModalRevealDriver,
	renderModalShell,
	renderModalShortcuts,
	SETTINGS_BROWSE_SHORTCUTS,
	withCompact,
} from "@veyyon/coding-agent/modes/components/modal-shell";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

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

	it("withCompact strips vertical margin", () => {
		const c = withCompact(MODAL_SIZING_SETTINGS, true);
		expect(c.vMargin).toBe(0);
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
	// border sliding down). These tests lock the clip's contracts so the
	// animation can never leak partial card rows below the moving border,
	// paint a borderless sliver, or alter the settled frame.
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

	it("returns the frame byte-identical at reveal >= 1 (settled state)", () => {
		const shell = renderCard();
		expect(applyModalReveal(shell, 120, 1)).toBe(shell.lines);
		expect(applyModalReveal(shell, 120, 2)).toBe(shell.lines);
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
		expect(applyModalReveal(shell, 18, 0.5)).toBe(shell.lines);
	});

	it("keeps the top border fixed and slides the BOTTOM border up mid-reveal", () => {
		const shell = renderCard();
		const geometry = shell.geometry!;
		const clipped = applyModalReveal(shell, 120, 0.5);
		// Top border row is byte-identical to the settled frame.
		expect(clipped[geometry.cardRowStart]).toBe(shell.lines[geometry.cardRowStart]!);
		// cardRowEnd is exclusive, matching hitTestModalChrome.
		const cardRows = geometry.cardRowEnd - geometry.cardRowStart;
		const visible = Math.max(2, Math.round(cardRows * 0.5));
		// The last visible row is the card's real bottom border, not a sheared body row.
		expect(clipped[geometry.cardRowStart + visible - 1]).toBe(shell.lines[geometry.cardRowEnd - 1]!);
		// Everything between the moved border and the settled border is blank.
		for (let row = geometry.cardRowStart + visible; row < geometry.cardRowEnd; row++) {
			expect(stripVTControlCharacters(clipped[row]!).trim()).toBe("");
		}
	});

	it("never shows a borderless sliver: reveal 0 still paints both border rows", () => {
		const shell = renderCard();
		const geometry = shell.geometry!;
		const clipped = applyModalReveal(shell, 120, 0);
		expect(clipped[geometry.cardRowStart]).toBe(shell.lines[geometry.cardRowStart]!);
		expect(clipped[geometry.cardRowStart + 1]).toBe(shell.lines[geometry.cardRowEnd - 1]!);
	});

	it("grows monotonically: a larger reveal never shows fewer card rows", () => {
		const shell = renderCard();
		const geometry = shell.geometry!;
		const visibleRows = (reveal: number): number => {
			const clipped = applyModalReveal(shell, 120, reveal);
			let count = 0;
			for (let row = geometry.cardRowStart; row < geometry.cardRowEnd; row++) {
				if (stripVTControlCharacters(clipped[row]!).trim() !== "") count++;
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
			if (stripVTControlCharacters(shell.lines[row]!).trim() !== "") settled++;
		}
		expect(previous).toBe(settled);
	});

	it("leaves rows outside the card region untouched at every phase", () => {
		const shell = renderCard();
		const geometry = shell.geometry!;
		for (const reveal of [0, 0.3, 0.7]) {
			const clipped = applyModalReveal(shell, 120, reveal);
			for (let row = 0; row < geometry.cardRowStart; row++) {
				expect(clipped[row]).toBe(shell.lines[row]!);
			}
			for (let row = geometry.cardRowEnd; row < shell.lines.length; row++) {
				expect(clipped[row]).toBe(shell.lines[row]!);
			}
		}
	});
});

describe("ModalRevealDriver — the wall-clock phase driver", () => {
	// Why: the driver is the only stateful piece of the unfold. These tests
	// lock its lifecycle so a settled overlay can never keep ticking renders
	// (a leaked interval re-rendering forever) and a started reveal always
	// begins collapsed instead of flashing the full card first.
	it("reports 1 before start (a never-animated card renders settled)", () => {
		const driver = new ModalRevealDriver();
		expect(driver.value).toBe(1);
	});

	it("starts collapsed, ticks renders, then settles at exactly 1 and stops ticking", async () => {
		const driver = new ModalRevealDriver();
		let ticks = 0;
		driver.start(() => {
			ticks++;
		});
		expect(driver.value).toBeLessThan(0.7); // collapsed-ish right after start
		expect(ticks).toBeGreaterThanOrEqual(1); // first paint requested synchronously
		await new Promise(resolve => setTimeout(resolve, 250)); // > REVEAL_MS
		expect(driver.value).toBe(1);
		const settledTicks = ticks;
		await new Promise(resolve => setTimeout(resolve, 120));
		expect(ticks).toBe(settledTicks); // interval self-cleared; no leak
	});

	it("stop() settles immediately mid-flight (dismount kills the animation)", () => {
		const driver = new ModalRevealDriver();
		driver.start(() => {});
		driver.stop();
		expect(driver.value).toBe(1);
	});
});
