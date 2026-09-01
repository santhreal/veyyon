/**
 * Every checked-in arm sets real veyyon settings to values the schema accepts.
 *
 * WHY THIS SUITE EXISTS. `run.ts` already refuses an arm whose keys are unknown or
 * whose values are mistyped, and refusing is the right behaviour: an unrecognised
 * key is merged into the config, never read, and the arm then runs as the CONTROL
 * while reporting under a treatment's name. A comparison of the control against
 * itself looks like a clean null result rather than a broken experiment, which is
 * the most expensive kind of wrong answer this bench can produce.
 *
 * But that check runs inside a run, after the binary is built and the auth database
 * is seeded, and its failure mode is a run that dies once it has already started
 * spending. Provider quota here is a hard daily pool shared across every experiment,
 * so a typo costs a slot that cannot be bought back until the pool resets. Running
 * the same validators over every `arms/*.yml` in the ordinary test gate moves that
 * discovery to somewhere free.
 *
 * These are deliberately the SAME functions `run.ts` calls, not a reimplementation.
 * A second copy of the rule would drift, and the drift would show up as a run
 * accepted by the gate and rejected by the runner, or worse the reverse.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getEnumValues, getType, isSettingPath } from "@veyyon/coding-agent/config/settings-schema";
import * as YAML from "yaml";
import { isArmConfigFile } from "./arm-fingerprint";

import { mistypedArmSettings, unknownArmSettings } from "./treatment-guard";

const ARMS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "arms");

/** Every arm file on disk, so a newly added arm is covered without editing this suite. */
function armFiles(): string[] {
	return fs.readdirSync(ARMS_DIR).filter(isArmConfigFile).sort();
}

describe("arms/*.yml — an arm that sets nothing real is a control wearing a treatment's name", () => {
	/**
	 * The suite is worthless if it silently covers nothing, which is exactly what a
	 * directory glob does when the path is wrong. Assert the arms are actually found
	 * and that the two arms this cost work depends on are among them.
	 */
	test("finds the arm directory and the arms under test", () => {
		const files = armFiles();
		expect(files.length).toBeGreaterThan(0);
		expect(files).toContain("sig-max4000.yml");
		expect(files).toContain("spill2kb.yml");
	});

	for (const file of armFiles()) {
		/**
		 * An unknown key is merged into the overlay and never read, so the arm runs as
		 * the control. The failure text names the offending paths because the usual
		 * cause is a spelling or a nesting mistake, and the reader needs to know which
		 * key rather than that some key was wrong.
		 */
		test(`${file} sets only real veyyon settings`, () => {
			const config = YAML.parse(fs.readFileSync(path.join(ARMS_DIR, file), "utf8")) ?? {};
			expect(unknownArmSettings(config, isSettingPath)).toEqual([]);
		});

		/**
		 * A value of the wrong type is merged and then ignored, which fails the same
		 * silent way an unknown key does. YAML is the usual culprit: bare `yes`/`no`
		 * parse as booleans and a quoted `"0.1"` stays a string, so a threshold can
		 * look right in the file and arrive as something the schema rejects.
		 */
		test(`${file} sets values the settings schema accepts`, () => {
			const config = YAML.parse(fs.readFileSync(path.join(ARMS_DIR, file), "utf8")) ?? {};
			const mistyped = mistypedArmSettings(config, p =>
				isSettingPath(p) ? { kind: getType(p), values: getEnumValues(p) } : undefined,
			);
			expect(mistyped).toEqual([]);
		});

		/**
		 * `run.ts` requires the file to be a mapping of setting to value. A sequence or
		 * a scalar would be rejected there, so it is rejected here too rather than
		 * being left to the run to discover.
		 */
		test(`${file} is a mapping rather than a sequence or a scalar`, () => {
			const config = YAML.parse(fs.readFileSync(path.join(ARMS_DIR, file), "utf8")) ?? {};
			expect(config).not.toBeNull();
			expect(typeof config).toBe("object");
			expect(Array.isArray(config)).toBe(false);
		});
	}
});
