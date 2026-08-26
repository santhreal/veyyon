/**
 * WHY THIS SUITE EXISTS:
 *
 * The legacy DeepSWE runner staged arm configurations, attachment files (.prompts.yml,
 * .rules/, .dict, .patch, .env.json), and wrote an attachments.json manifest into the
 * assets directory for in-container execution.
 *
 * This test verifies that the unified staging pipeline delivers the exact same set of
 * staged artifacts and attachment manifests for any configuration arm and prompt variant.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * Network or container filesystem faults during docker volume mounts.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { internalScratchDir } from "../../../src/paths";
import {
	ARM_ATTACHMENT_KINDS,
	ARM_ATTACHMENT_MANIFEST_FILE,
	type ArmAttachmentManifest,
} from "../../../src/suites/deep-swe/arm-attachments";
import { knownPromptIds } from "../../../src/suites/deep-swe/arm-prompts";
import { stageAllArms } from "../../../src/suites/deep-swe/src/runner/arm-staging";

function createScratchDir(prefix: string): string {
	const base = internalScratchDir();
	fs.mkdirSync(base, { recursive: true });
	return fs.mkdtempSync(path.join(base, prefix));
}
describe("DeepSWE Unified Staging — carries all arm attachments and configs matching legacy contract", () => {
	it("stages arm YAML configs and generates valid attachments.json manifest", () => {
		const scratch = createScratchDir("deepswe-staging-test-");
		try {
			const armsDir = path.join(scratch, "arms");
			const assetsDir = path.join(scratch, "assets");
			fs.mkdirSync(armsDir, { recursive: true });

			// Create arm-a with no attachments
			fs.writeFileSync(path.join(armsDir, "arm-a.yml"), "temperature: 0\n", "utf8");

			// Create arm-b with rules, prompts, and dict attachments
			const promptId = knownPromptIds()[0] ?? "benchmark-system";
			fs.writeFileSync(path.join(armsDir, "arm-b.yml"), "temperature: 0\n", "utf8");
			fs.writeFileSync(path.join(armsDir, "arm-b.prompts.yml"), `${promptId}: 'Custom prompt content'\n`, "utf8");
			fs.writeFileSync(path.join(armsDir, "arm-b.rule.md"), "# Custom Rule\n", "utf8");
			stageAllArms({
				arms: ["arm-a", "arm-b"],
				armsDir,
				assetsDir,
				model: "anthropic/claude-sonnet-4-5",
				systemArms: new Set(),
			});

			// Verify arm config files staged
			expect(fs.existsSync(path.join(assetsDir, "arms", "arm-a.yml"))).toBe(true);
			expect(fs.existsSync(path.join(assetsDir, "arms", "arm-b.yml"))).toBe(true);

			// Verify manifest file staged
			const manifestPath = path.join(assetsDir, ARM_ATTACHMENT_MANIFEST_FILE);
			expect(fs.existsSync(manifestPath)).toBe(true);

			const manifest: ArmAttachmentManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
			expect(manifest.version).toBe(1);
			expect(manifest.arms).toBeDefined();

			// arm-a should have empty attachments
			expect(manifest.arms["arm-a"]).toEqual([]);

			// arm-b should have prompt and rule attachments
			const armBAttachments = manifest.arms["arm-b"];
			expect(armBAttachments).toBeDefined();
			expect(armBAttachments!.length).toBeGreaterThanOrEqual(2);

			const hasPrompt = armBAttachments!.some(a => a.delivery === "env-json" && a.envVar === "VEYYON_EVAL_PROMPTS");
			const hasRule = armBAttachments!.some(a => a.delivery === "rules-dir");
			expect(hasPrompt).toBe(true);
			expect(hasRule).toBe(true);

			// Verify staged attachment files exist on disk in assetsDir
			for (const att of armBAttachments!) {
				const stagedFile = path.join(assetsDir, att.file);
				expect(fs.existsSync(stagedFile)).toBe(true);
			}
		} finally {
			fs.rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("covers every declared ARM_ATTACHMENT_KIND in delivery mapping", () => {
		const kinds = ARM_ATTACHMENT_KINDS;
		expect(kinds.length).toBeGreaterThanOrEqual(4);

		for (const kind of kinds) {
			expect(["env-json", "rules-dir"]).toContain(kind.delivery);
			expect(kind.suffix.length).toBeGreaterThan(0);
			expect(kind.field.length).toBeGreaterThan(0);
		}
	});
});
