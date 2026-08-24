import { beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import {
	COMPOSER_PLACEHOLDER,
	COMPOSER_RESTING_ROWS,
	ComposerHairline,
	StaticComposerFrame,
} from "@veyyon/coding-agent/modes/components/composer-chrome";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { visibleWidth } from "@veyyon/tui/utils";

/**
 * WHY: startup used to paint eight BLANK rows where the composer would live,
 * so the prompt appeared only when InteractiveMode.init finished — reading as
 * the composer "sliding up" seconds after launch. The first frame now paints
 * a static resting composer into those rows, and the real zone mounts into
 * the same height, so the handover changes text and never position.
 *
 * These tests close the class "the first-frame composer drifts from the
 * mounted one": the static frame must render exactly the reserved row count,
 * must carry the real hairline bytes (same owner), must show the shared ghost
 * placeholder, and must be time-invariant — nothing on it may animate.
 */

beforeAll(async () => {
	await initTheme(false);
});

describe("static first-frame composer", () => {
	it("renders exactly the resting zone's row count", () => {
		const frame = new StaticComposerFrame();
		expect(frame.render(100)).toHaveLength(COMPOSER_RESTING_ROWS);
	});

	it("shows the hairline with its real bytes", () => {
		const frame = new StaticComposerFrame();
		const rows = frame.render(100);
		const hairline = new ComposerHairline().render(100)[0];
		expect(rows).toContain(hairline);
	});

	it("shows the shared ghost placeholder inset by the composer margin", () => {
		const frame = new StaticComposerFrame();
		const inputRow = frame.render(100).find(row => row.includes(COMPOSER_PLACEHOLDER));
		expect(inputRow).toBeDefined();
		expect(visibleWidth(inputRow as string)).toBeLessThanOrEqual(100);
	});

	it("never animates: identical bytes at different wall-clock times", async () => {
		const frame = new StaticComposerFrame();
		const first = frame.render(100);
		await Bun.sleep(30);
		setSystemTime(new Date(Date.now() + 5_000));
		try {
			expect(frame.render(100)).toEqual(first);
		} finally {
			setSystemTime();
		}
	});

	it("clips to narrow widths without throwing or wrapping", () => {
		const frame = new StaticComposerFrame();
		for (const width of [1, 10, 40]) {
			const rows = frame.render(width);
			expect(rows).toHaveLength(COMPOSER_RESTING_ROWS);
			for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		}
	});
});
