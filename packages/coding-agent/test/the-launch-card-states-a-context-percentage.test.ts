/**
 * The gauge on the launch card states a number, and never a number for somewhere else.
 *
 * WHY THIS SUITE EXISTS. The card paints about half a second before the session finishes
 * assembling the prompt the gauge counts, so it rendered `? left` and the session replaced it
 * with `82% left` under a composer the operator was already typing into. Two things were wrong
 * with that frame and they fail independently: the card had no number, and the two states were
 * different WIDTHS, so the arrival slid the whole right-hand group of a justified row.
 *
 * THE CLASS, NOT THE INCIDENT. The width half is asserted over every value the formatter can
 * produce, in `status-line-context-gauge.test.ts`, because `?` was only the loudest member —
 * `9%` to `10%` and `99%` to `100%` moved the row the same way mid-session. The number half is
 * asserted here, and the defect it guards against is not "the card shows `?`" but "the card
 * shows a percentage taken under conditions that no longer hold". Every input the reading
 * depends on gets a case: change it, and the card must fall back to `?` rather than state a
 * number it cannot stand behind.
 *
 * WHAT IT DOES NOT CATCH. The reading is only as current as the last launch. An `AGENTS.md`
 * edit, a new skill or an MCP server moves the prompt without moving the key, and that is a
 * deliberate trade recorded in the module: the frame states the previous number and the session
 * corrects it in place. This suite pins the keys that DO invalidate, so a future input that
 * ought to invalidate is a hole here rather than a silent wrong number.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { settings } from "@veyyon/coding-agent/config/settings-instance";
import {
	readLaunchGaugePercent,
	recordLaunchGaugePercent,
	resetLaunchGaugeBaselineForTest,
} from "@veyyon/coding-agent/modes/terminal/components/status-line/launch-gauge-baseline";
import { launchSegmentContext } from "@veyyon/coding-agent/modes/terminal/components/status-line/session-facts";
import { getLaunchGaugeCachePath, refreshDirsFromEnv } from "@veyyon/utils";

interface LaunchGaugeFile {
	key: string;
	percent: number;
}

let configRoot: string;
let previousRoot: string | undefined;

/**
 * Record a reading and wait for the write the recorder hands back.
 *
 * The product discards that promise — the value is worth one frame on the next launch — but it
 * is the completion signal, so a test awaits it rather than sleeping on a guess.
 */
async function record(percent: number): Promise<void> {
	resetLaunchGaugeBaselineForTest();
	await recordLaunchGaugePercent(percent);
}

/** What is on disk right now, parsed. */
function onDisk(): LaunchGaugeFile {
	return JSON.parse(readFileSync(getLaunchGaugeCachePath(), "utf8")) as LaunchGaugeFile;
}

beforeEach(async () => {
	previousRoot = process.env.VEYYON_CONFIG_ROOT;
	configRoot = mkdtempSync(path.join(os.tmpdir(), "veyyon-launch-gauge-"));
	process.env.VEYYON_CONFIG_ROOT = configRoot;
	refreshDirsFromEnv();
	resetSettingsForTest();
	resetLaunchGaugeBaselineForTest();
	await Settings.init({ cwd: configRoot });
});

afterEach(() => {
	if (previousRoot === undefined) delete process.env.VEYYON_CONFIG_ROOT;
	else process.env.VEYYON_CONFIG_ROOT = previousRoot;
	refreshDirsFromEnv();
	resetSettingsForTest();
	resetLaunchGaugeBaselineForTest();
	rmSync(configRoot, { recursive: true, force: true });
});

describe("the launch card's context percentage", () => {
	/** Every first launch in a project. The gauge says it does not know, which it does not. */
	it("is absent before anything has been recorded", () => {
		expect(readLaunchGaugePercent()).toBeNull();
	});

	/**
	 * The round trip, through the two functions the product uses and the real file. Whole
	 * percent because that is what the gauge prints; a stored fraction would rewrite the file
	 * on every redraw of an idle session for a difference nobody can see.
	 */
	it("states the reading the last launch recorded, as a whole percent", async () => {
		await record(17.6);

		expect(readLaunchGaugePercent()).toBe(18);
	});

	/**
	 * The card's own context block is what the segment table renders from, so the reading has
	 * to arrive as `contextPercent` and not merely be readable from the module. This is the
	 * seam that made the card show `?`: `launchSegmentContext` hardcoded null.
	 */
	it("reaches the card's segment context", async () => {
		await record(40);

		const ctx = launchSegmentContext({
			width: 120,
			options: {},
			compactThinkingLevel: false,
			branch: null,
			autoCompactEnabled: true,
		});

		expect(ctx.contextPercent).toBe(40);
	});

	/**
	 * THE INVALIDATION CASES. Each names one input the reading was taken under. A reading kept
	 * across any of them is a number the card cannot stand behind, and the honest answer is the
	 * `?` the gauge already spells.
	 */
	it("is absent for a different model, because the model decides the window", async () => {
		settings.setModelRole("default", "anthropic/claude-sonnet-4");
		await record(40);
		expect(readLaunchGaugePercent()).toBe(40);

		settings.setModelRole("default", "openai/gpt-5");

		expect(readLaunchGaugePercent()).toBeNull();
	});

	it("is absent for a different project, because the context files come from it", async () => {
		await record(40);
		const recorded = onDisk();

		writeFileSync(
			getLaunchGaugeCachePath(),
			JSON.stringify({ ...recorded, key: recorded.key.replace(/\|[^|]*$/, "|/somewhere/else") }),
		);

		expect(readLaunchGaugePercent()).toBeNull();
	});

	it("is absent for a different release, because the prompt and the tools ship with it", async () => {
		await record(40);
		const recorded = onDisk();

		writeFileSync(getLaunchGaugeCachePath(), JSON.stringify({ ...recorded, key: `0.0.0-other|${recorded.key}` }));

		expect(readLaunchGaugePercent()).toBeNull();
	});

	/**
	 * A file truncated by a crash mid-write, hand-edited, or replaced with a JSON value of the
	 * wrong shape. The card must fall back to `?` rather than throw on the frame it is painting
	 * or paint whatever the damaged value coerces to.
	 */
	it("is absent for a damaged file, whatever the damage", async () => {
		await record(40);
		const { key } = onDisk();

		for (const damaged of [
			"",
			"{",
			"null",
			"[]",
			'"40"',
			JSON.stringify({ key }),
			JSON.stringify({ key, percent: "40" }),
			JSON.stringify({ key, percent: null }),
			JSON.stringify({ percent: 40 }),
		]) {
			writeFileSync(getLaunchGaugeCachePath(), damaged);

			expect(readLaunchGaugePercent()).toBeNull();
		}
	});

	/**
	 * A percentage outside the band is a damaged file that still parses. Clamped rather than
	 * rejected, because the bar and the number both derive from it and a gauge drawn from 140
	 * would overflow its own cells.
	 */
	it("clamps a reading from outside the band", async () => {
		await record(40);
		const { key } = onDisk();

		writeFileSync(getLaunchGaugeCachePath(), JSON.stringify({ key, percent: 140 }));
		expect(readLaunchGaugePercent()).toBe(100);

		writeFileSync(getLaunchGaugeCachePath(), JSON.stringify({ key, percent: -20 }));
		expect(readLaunchGaugePercent()).toBe(0);
	});

	/**
	 * An idle session redraws its row continuously and every redraw reaches the recorder with
	 * the same reading. The write has to stop at the first, which is asserted by planting a
	 * sentinel and watching it survive: a recorder that rewrites per frame is write
	 * amplification nobody would notice in the output.
	 */
	it("writes once for a reading that has not changed", async () => {
		await record(40);
		const sentinel = { key: "planted-by-the-test", percent: 99 };
		writeFileSync(getLaunchGaugeCachePath(), JSON.stringify(sentinel));

		for (let redraw = 0; redraw < 50; redraw++) await recordLaunchGaugePercent(40);

		expect(onDisk()).toEqual(sentinel);
	});

	/** A reading that moved is a new baseline, so the next launch sees the current one. */
	it("writes again for a reading that changed", async () => {
		await record(40);

		await recordLaunchGaugePercent(55);

		expect(readLaunchGaugePercent()).toBe(55);
	});
});
