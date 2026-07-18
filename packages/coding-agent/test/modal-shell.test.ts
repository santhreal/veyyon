import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
	computeModalDims,
	fitTipLine,
	hitTestModalChrome,
	MODAL_SIZING_LARGE,
	MODAL_SIZING_SETTINGS,
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
		// The trailing row must carry at least two chips, not a solitary one.
		expect(rows[1]?.includes("|")).toBe(true);
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
		// No row after the first may be a solitary chip beneath a fuller row.
		for (let i = 1; i < rows.length; i++) {
			const soloChip = !rows[i]!.includes("|");
			expect(soloChip && rows[i - 1]!.includes("|")).toBe(false);
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
