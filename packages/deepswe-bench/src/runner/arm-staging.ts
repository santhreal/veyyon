/**
 * Arm staging, configuration validation, prompt overrides, and attachment manifests.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getEnumValues, getType, isSettingPath } from "@veyyon/coding-agent/config/settings-schema";
import { isRecord } from "@veyyon/utils";
import YAML from "yaml";
import {
	ARM_ATTACHMENT_KINDS,
	type ArmAttachmentManifestEntry,
	type ArmAttachmentValues,
	isArmAttachmentError,
	mappingOf,
	readArmAttachment,
	stageArmAttachment,
	writeArmAttachmentManifest,
} from "../../arm-attachments";
import { computeArmFingerprint, findZeroIvCollisions } from "../../arm-fingerprint";
import { promptOverrideIdError } from "../../arm-prompts";
import { encodeArmModelMismatch, isEncodeArm, mistypedArmSettings, unknownArmSettings } from "../../treatment-guard";
import { effectiveTemperature, PINNED_TEMPERATURE } from "../aggregate";

export interface StagedArmsResult {
	armTemperature: Map<string, number>;
	armFingerprints: Map<string, string>;
	encodeArms: Set<string>;
	stagedAttachments: Map<string, readonly ArmAttachmentManifestEntry[]>;
}

export function stageAllArms(opts: {
	arms: string[];
	benchDir: string;
	assetsDir: string;
	model: string;
	systemArms: Set<string>;
}): StagedArmsResult {
	const { arms, benchDir, assetsDir, model, systemArms } = opts;
	const armTemperature = new Map<string, number>();
	const armFingerprints = new Map<string, string>();
	const encodeArms = new Set<string>();
	const stagedAttachments = new Map<string, readonly ArmAttachmentManifestEntry[]>();

	fs.mkdirSync(path.join(assetsDir, "arms"), { recursive: true });

	for (const arm of arms) {
		// System arms that don't support attachments (omp, factory, hermes)
		// skip YAML config loading. Veyyon as a system arm still loads baseline.yml.
		const isSystemArm = systemArms.has(arm);
		if (isSystemArm && arm !== "veyyon") {
			armTemperature.set(arm, PINNED_TEMPERATURE);
			armFingerprints.set(arm, createHash("sha256").update(`system-adapter:${arm}`).digest("hex"));
			stagedAttachments.set(arm, []);
			continue;
		}

		const configArm = isSystemArm ? "baseline" : arm;
		const armYmlPath = path.join(benchDir, "arms", `${configArm}.yml`);
		if (!fs.existsSync(armYmlPath)) {
			console.error(`missing arm config: ${armYmlPath}`);
			process.exit(1);
		}

		const ymlText = fs.readFileSync(armYmlPath, "utf8");
		let config: unknown;
		try {
			config = YAML.parse(ymlText) ?? {};
		} catch (err) {
			console.error(`error: arm "${arm}" has invalid YAML in arms/${arm}.yml:\n${err}`);
			process.exit(1);
		}

		if (!isRecord(config)) {
			console.error(
				`error: arm "${arm}" arms/${arm}.yml must be a mapping of setting -> value, ` +
					`got ${Array.isArray(config) ? "a sequence" : typeof config}.`,
			);
			process.exit(1);
		}

		const mistyped = mistypedArmSettings(config, p =>
			isSettingPath(p) ? { kind: getType(p), values: getEnumValues(p) } : undefined,
		);
		if (mistyped.length > 0) {
			console.error(
				`error: arm "${arm}" arms/${arm}.yml sets ${mistyped.length} key(s) to a value the settings\n` +
					`schema would reject:\n` +
					mistyped.map(m => `  ${m.path}: expected ${m.expected}, got ${m.actual}`).join("\n"),
			);
			process.exit(1);
		}

		const unknown = unknownArmSettings(config, isSettingPath);
		if (unknown.length > 0) {
			console.error(
				`error: arm "${arm}" arms/${arm}.yml sets ${unknown.length} key(s) that are not veyyon settings:\n` +
					unknown.map(p => `  ${p}`).join("\n"),
			);
			process.exit(1);
		}

		const temperature = effectiveTemperature(config);
		(config as Record<string, unknown>).temperature = temperature;
		armTemperature.set(arm, temperature);

		if (isEncodeArm(config)) encodeArms.add(arm);
		fs.writeFileSync(path.join(assetsDir, "arms", `${arm}.yml`), YAML.stringify(config));

		const mismatch = encodeArmModelMismatch(config, model);
		if (mismatch !== null) {
			console.error(
				`error: arm "${arm}" enables argot encoding with an allowlist that does not\n` +
					`include the model under test, so it would SILENTLY degrade to decode-only:\n` +
					`  arms/${arm}.yml argot.models = [${mismatch.join(", ")}]\n` +
					`  --model = ${model}`,
			);
			process.exit(1);
		}

		const attachments: ArmAttachmentValues = {};
		const staged: ArmAttachmentManifestEntry[] = [];
		for (const kind of ARM_ATTACHMENT_KINDS) {
			const read = readArmAttachment(kind, path.join(benchDir, "arms"), arm, configArm);
			if (isArmAttachmentError(read)) {
				console.error(`error: ${read.error}`);
				process.exit(1);
			}
			if (!read.present) continue;

			if (kind.field === "prompts") {
				const problem = promptOverrideIdError(arm, mappingOf(read.payload) ?? {});
				if (problem !== null) {
					console.error(`error: ${problem}`);
					process.exit(1);
				}
			}
			attachments[kind.field] = ("mapping" in read.payload ? read.payload.mapping : read.payload.bytes) as never;
			staged.push(stageArmAttachment(kind, assetsDir, arm, read.payload));
		}
		stagedAttachments.set(arm, staged);
		armFingerprints.set(arm, computeArmFingerprint({ config, ...attachments }));
	}

	writeArmAttachmentManifest(assetsDir, stagedAttachments);

	if (arms.length >= 2) {
		const collisions = findZeroIvCollisions(armFingerprints);
		if (collisions.length > 0) {
			const detail = collisions.map(group => `  {${group.join(", ")}} reduce to identical inputs`).join("\n");
			console.error(
				"error: zero-IV arm collision — a controlled comparison must vary exactly one\n" +
					`independent variable, but these arms reduce to the same inputs:\n${detail}`,
			);
			process.exit(1);
		}
	}

	return {
		armTemperature,
		armFingerprints,
		encodeArms,
		stagedAttachments,
	};
}
