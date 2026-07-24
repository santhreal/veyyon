/**
 * The design.md Canvas rule, realized: a surface that owns the whole viewport
 * paints pure black edge to edge.
 *
 * Why this suite exists: `renderSunField` shipped a tested `paintBackground`
 * option that NO production caller used (FINDING-SUN-PAINTBACKGROUND-UNWIRED)
 * — the setup wizard drew the sun on the terminal's inherited background, so
 * the brand's silver-on-black launch sequence looked different on every
 * terminal color. The wizard now paints its full frame through
 * `paintCanvasBlack` in one place (wizard-overlay render), covering splash,
 * dissolve transition, scenes, outro, and fit-to-screen filler rows alike.
 * These tests pin the ground on every row and the reset discipline at row
 * ends, and the re-arm behavior that stops a row's own SGR reset from
 * punching a hole in the ground. This is full-viewport-overlay behavior ONLY;
 * the inline transcript's no-background contract is locked separately by
 * no-background-paint.test.ts.
 */
import { beforeAll, describe, expect, it, vi } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { CANVAS_BG_ESCAPE, paintCanvasBlack } from "@veyyon/coding-agent/modes/components/sun";
import type { SetupScene, SetupWizardContext } from "@veyyon/coding-agent/modes/setup-wizard/scenes/types";
import { SetupWizardComponent } from "@veyyon/coding-agent/modes/setup-wizard/wizard-overlay";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	await initTheme(false);
});

/** ANSI-aware visible width: strip SGRs, count code points. */
function visibleLength(line: string): number {
	return [...line.replace(/\x1b\[[0-9;]*m/g, "")].length;
}

describe("paintCanvasBlack (the Canvas ground painter)", () => {
	it("grounds, pads, and closes every row: black prefix, full width, trailing reset", () => {
		const rows = paintCanvasBlack(["short", "", "wider row here"], 20);
		expect(rows).toHaveLength(3);
		for (const row of rows) {
			expect(row.startsWith(CANVAS_BG_ESCAPE)).toBe(true);
			expect(row.endsWith("\x1b[0m")).toBe(true);
			// The pad spaces sit BEFORE the reset, so the ground reaches the edge.
			expect(visibleLength(row)).toBe(20);
		}
	});

	it("re-arms the ground after a row's own SGR reset instead of letting it punch a hole", () => {
		// A styled span that resets mid-row: everything after `\x1b[0m` would
		// otherwise fall back to the terminal's background.
		const [row] = paintCanvasBlack(["\x1b[31mred\x1b[0m plain tail"], 30);
		expect(row).toContain(`\x1b[0m${CANVAS_BG_ESCAPE}`);
		// The bg-default sentinel is likewise replaced by the ground.
		const [sentinelRow] = paintCanvasBlack(["a\x1b[49mb"], 10);
		expect(sentinelRow).not.toContain("\x1b[49m");
		expect(sentinelRow.split(CANVAS_BG_ESCAPE).length).toBeGreaterThan(2);
	});

	it("keeps exactly-width rows intact apart from the ground and reset", () => {
		const content = "x".repeat(12);
		const [row] = paintCanvasBlack([content], 12);
		expect(row).toBe(`${CANVAS_BG_ESCAPE}${content}\x1b[0m`);
	});
});

describe("setup wizard frames sit on the Canvas ground", () => {
	function makeComponent(): SetupWizardComponent {
		const scene: SetupScene = {
			id: "s",
			title: "s",
			minVersion: 1,
			mount: () => ({ title: "s", render: () => ["scene body"], invalidate: () => {} }),
		};
		const ctx = {
			settings: Settings.isolated(),
			ui: { terminal: { rows: 18 }, setFocus: () => {}, requestRender: () => {} },
			refreshComposerShortcuts: vi.fn(),
			dismissWelcome: vi.fn(),
		} as unknown as SetupWizardContext;
		return new SetupWizardComponent(ctx, [scene]);
	}

	/** Every row of the full-viewport frame — including rows the splash leaves
	 * visually empty — must carry the black ground to the right edge. */
	it("splash frame: all terminal rows grounded black, full width, reset-closed", () => {
		const component = makeComponent();
		void component.run();
		const frame = component.render(64);
		expect(frame.length).toBe(18);
		for (const row of frame) {
			expect(row.startsWith(CANVAS_BG_ESCAPE)).toBe(true);
			expect(row.endsWith("\x1b[0m")).toBe(true);
			expect(visibleLength(row)).toBe(64);
		}
	});

	/** Post-splash phases (the dissolve transition into the scene) paint the
	 * same ground: the rule lives at the overlay level's single render exit, so
	 * no phase can drift to an unpainted frame. */
	it("post-splash frame: the ground survives the phase change", () => {
		const component = makeComponent();
		void component.run();
		// Enter advances out of the splash (into the dissolve toward the scene).
		component.handleInput?.("\n");
		const frame = component.render(50);
		expect(frame.length).toBe(18);
		for (const row of frame) {
			expect(row.startsWith(CANVAS_BG_ESCAPE)).toBe(true);
			expect(visibleLength(row)).toBe(50);
		}
	});
});
