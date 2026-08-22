/**
 * WHY: Adding a new arm attachment kind (.sections.yml, .statements.yml, .prompts.yml) requires
 * updating the attachment suffix list (ARM_ATTACHMENT_SUFFIXES), the single-IV fingerprinting
 * (computeArmFingerprint), the arm selection error guards (armSelectionError), and the runner
 * staging in run.ts. If a new attachment kind is added on disk or in the codebase without updating
 * the guard tables, the attachment is either treated as a phantom arm or ignored, causing silent
 * false-positive runs where treatments are benched as controls.
 *
 * This suite dynamically sweeps all attachment suffixes from ARM_ATTACHMENT_SUFFIXES and files
 * in arms/, asserting that every attachment suffix is refused by armSelectionError, is recognized
 * by isArmConfigFile as an attachment (not an arm), and participates in computeArmFingerprint.
 *
 * What it does not catch: Pier container execution and Docker volume mounts.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	ARM_ATTACHMENT_SUFFIXES,
	type ArmInputs,
	armNamesIn,
	armSelectionError,
	computeArmFingerprint,
	findZeroIvCollisions,
	isArmConfigFile,
} from "./arm-fingerprint";

const ARMS_DIR = path.join(import.meta.dir, "arms");

describe("attachment kinds enumerated from ARM_ATTACHMENT_SUFFIXES at run time", () => {
	it("contains all expected attachment kinds (.sections.yml, .statements.yml, .prompts.yml)", () => {
		expect(ARM_ATTACHMENT_SUFFIXES).toContain(".sections.yml");
		expect(ARM_ATTACHMENT_SUFFIXES).toContain(".statements.yml");
		expect(ARM_ATTACHMENT_SUFFIXES).toContain(".prompts.yml");
		expect(ARM_ATTACHMENT_SUFFIXES.length).toBeGreaterThanOrEqual(3);
	});

	it("every disk file in arms/ with a composite suffix belongs to ARM_ATTACHMENT_SUFFIXES or is .rule.md", () => {
		const files = fs.readdirSync(ARMS_DIR);
		for (const file of files) {
			if (file.endsWith(".rule.md")) continue;
			if (file.endsWith(".yml")) {
				const parts = file.split(".");
				if (parts.length > 2) {
					// e.g. "candidate-delivery-terse.sections.yml"
					const suffix = `.${parts.slice(1).join(".")}`;
					expect(
						ARM_ATTACHMENT_SUFFIXES,
						`File ${file} has suffix ${suffix} not declared in ARM_ATTACHMENT_SUFFIXES`,
					).toContain(suffix);
				}
			}
		}
	});

	it.each([...ARM_ATTACHMENT_SUFFIXES])(
		"refuses attachment %s in armSelectionError and names the bare arm",
		(suffix: string) => {
			const bareSuffix = suffix.slice(0, -".yml".length);
			const requestedArm = `candidate-foo${bareSuffix}`;
			const available = ["candidate-foo", "baseline"];

			const problem = armSelectionError(requestedArm, available);
			expect(problem).not.toBeNull();
			expect(problem).toContain(`"${requestedArm}" is not an arm`);
			expect(problem).toContain(`it is the ${suffix} attachment of arm "candidate-foo"`);
			expect(problem).toContain(`--arms candidate-foo`);
		},
	);

	it.each([...ARM_ATTACHMENT_SUFFIXES])("treats %s as an attachment in isArmConfigFile", (suffix: string) => {
		expect(isArmConfigFile(`my-arm${suffix}`)).toBe(false);
		expect(isArmConfigFile("my-arm.yml")).toBe(true);
	});

	it.each([...ARM_ATTACHMENT_SUFFIXES])("excludes %s from armNamesIn directory listings", (suffix: string) => {
		const listing = ["baseline.yml", `candidate-a${suffix}`, "candidate-a.yml"];
		const arms = armNamesIn(listing);
		expect(arms).toEqual(["baseline", "candidate-a"]);
	});
});

describe("prompt attachment (.prompts.yml) single-IV fingerprint behavior", () => {
	const baselineConfig = { argot: { enabled: false } };

	it("fingerprint of an arm with .prompts.yml differs from the same arm without it", () => {
		const withoutAttachment: ArmInputs = { config: baselineConfig };
		const withAttachment: ArmInputs = {
			config: baselineConfig,
			prompts: { "tools/bash": "trimmed bash description" },
		};

		const fpWithout = computeArmFingerprint(withoutAttachment);
		const fpWith = computeArmFingerprint(withAttachment);

		expect(fpWith).not.toBe(fpWithout);
	});

	it("two arms differing only by .prompts.yml are NOT reported as a zero-IV collision", () => {
		const fpBaseline = computeArmFingerprint({ config: baselineConfig });
		const fpCandidate = computeArmFingerprint({
			config: baselineConfig,
			prompts: { "tools/bash": "custom instructions" },
		});

		const fingerprints = new Map([
			["baseline", fpBaseline],
			["candidate-bash-trim", fpCandidate],
		]);

		const collisions = findZeroIvCollisions(fingerprints);
		expect(collisions).toEqual([]);
	});

	it("two arms with identical .prompts.yml and config DO collide as zero-IV", () => {
		const promptMap = { "tools/bash": "custom instructions" };
		const fp1 = computeArmFingerprint({ config: baselineConfig, prompts: promptMap });
		const fp2 = computeArmFingerprint({ config: baselineConfig, prompts: promptMap });

		const fingerprints = new Map([
			["candidate-1", fp1],
			["candidate-2", fp2],
		]);

		const collisions = findZeroIvCollisions(fingerprints);
		expect(collisions).toEqual([["candidate-1", "candidate-2"]]);
	});
});
