/**
 * Staging owner for Pier execution backend assets.
 *
 * Prepares <runDir>/assets before trials run:
 * - vey binary executable (mode 0o755) and its SHA-256 digest
 * - auth-agent.db SQLite credential store
 * - arms/<variant>.yml per variant (overlay YAML or empty map {})
 * - prompt/statement/section/rule attachments and attachments.json manifest
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import {
	ARM_ATTACHMENT_KINDS,
	type ArmAttachmentManifestEntry,
	attachmentKindOf,
	isArmAttachmentError,
	readArmAttachment,
	stageArmAttachment,
	writeArmAttachmentManifest,
} from "../../core/arm-attachments";
import type { Variant } from "../../core/types";

export interface StagedPierAssets {
	readonly binarySha: string;
	readonly armFiles: ReadonlyMap<string, string>;
}

export interface StagePierAssetsParams {
	readonly assetsDir: string;
	readonly variants: readonly Variant[];
	readonly veyBinary: string;
	readonly authDb: string;
}

export function stagePierAssets(params: StagePierAssetsParams): StagedPierAssets {
	const { assetsDir, variants, veyBinary, authDb } = params;

	fs.mkdirSync(assetsDir, { recursive: true });
	const armsDir = path.join(assetsDir, "arms");
	fs.mkdirSync(armsDir, { recursive: true });

	if (!fs.existsSync(veyBinary)) {
		throw new Error(`vey binary not found at ${veyBinary}`);
	}
	const destBinary = path.join(assetsDir, "vey");
	fs.copyFileSync(veyBinary, destBinary);
	fs.chmodSync(destBinary, 0o755);
	const binarySha = createHash("sha256").update(fs.readFileSync(destBinary)).digest("hex");

	if (!fs.existsSync(authDb)) {
		throw new Error(`auth database not found at ${authDb}`);
	}
	const destAuthDb = path.join(assetsDir, "auth-agent.db");
	fs.copyFileSync(authDb, destAuthDb);

	const armFiles = new Map<string, string>();
	const entriesByVariant = new Map<string, ArmAttachmentManifestEntry[]>();

	for (const variant of variants) {
		const armPath = path.join(armsDir, `${variant.name}.yml`);
		if (variant.configPath === null) {
			fs.writeFileSync(armPath, "{}\n");
		} else {
			if (!fs.existsSync(variant.configPath)) {
				throw new Error(`Variant "${variant.name}" configPath does not exist: ${variant.configPath}`);
			}
			const rawContent = fs.readFileSync(variant.configPath, "utf8");
			let parsed: unknown;
			try {
				parsed = YAML.parse(rawContent) ?? {};
			} catch (err) {
				throw new Error(`Variant "${variant.name}" configPath has invalid YAML in ${variant.configPath}:\n${err}`);
			}
			fs.writeFileSync(armPath, `${YAML.stringify(parsed)}\n`);
		}
		armFiles.set(variant.name, armPath);

		const entries: ArmAttachmentManifestEntry[] = [];

		// Derived attachments from configPath
		if (variant.configPath !== null) {
			const configDir = path.dirname(variant.configPath);
			const basename = path.basename(variant.configPath);
			const stem = basename.endsWith(".yml")
				? basename.slice(0, -4)
				: basename.endsWith(".yaml")
					? basename.slice(0, -5)
					: basename;
			for (const kind of ARM_ATTACHMENT_KINDS) {
				const candidate = path.join(configDir, `${stem}${kind.suffix}`);
				if (fs.existsSync(candidate)) {
					const read = readArmAttachment(kind, configDir, variant.name, stem);
					if (isArmAttachmentError(read)) {
						throw new Error(`Variant "${variant.name}": ${read.error}`);
					}
					if (read.present) {
						const entry = stageArmAttachment(kind, assetsDir, variant.name, read.payload);
						const existingIndex = entries.findIndex(e => e.kind === entry.kind);
						if (existingIndex >= 0) {
							entries[existingIndex] = entry;
						} else {
							entries.push(entry);
						}
					}
				}
			}
		}

		// Explicit attachments
		for (const rawPath of variant.attachments) {
			const kind = attachmentKindOf(rawPath);
			if (!kind) {
				const understood = ARM_ATTACHMENT_KINDS.map(k => k.suffix).join(", ");
				throw new Error(
					`Variant "${variant.name}" attachment "${rawPath}" has unknown suffix. Understood suffixes: ${understood}`,
				);
			}
			if (!fs.existsSync(rawPath)) {
				throw new Error(`Variant "${variant.name}" attachment path does not exist: ${rawPath}`);
			}
			const dir = path.dirname(rawPath);
			const base = path.basename(rawPath);
			const stem = base.slice(0, -kind.suffix.length);
			const read = readArmAttachment(kind, dir, variant.name, stem);
			if (isArmAttachmentError(read)) {
				throw new Error(`Variant "${variant.name}": ${read.error}`);
			}
			if (read.present) {
				const entry = stageArmAttachment(kind, assetsDir, variant.name, read.payload);
				const existingIndex = entries.findIndex(e => e.kind === entry.kind);
				if (existingIndex >= 0) {
					entries[existingIndex] = entry;
				} else {
					entries.push(entry);
				}
			}
		}

		entriesByVariant.set(variant.name, entries);
	}

	writeArmAttachmentManifest(assetsDir, entriesByVariant);

	return {
		binarySha,
		armFiles,
	};
}
