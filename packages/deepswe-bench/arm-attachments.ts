import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import type { ArmInputs } from "./arm-fingerprint";

export type ArmAttachmentDelivery = "env-json" | "rules-dir";

interface ArmAttachmentKindBase {
	readonly suffix: string;
	readonly field: keyof Omit<ArmInputs, "config">;
	readonly stagedDir: string;
}

export interface MappingAttachmentKind extends ArmAttachmentKindBase {
	readonly delivery: "env-json";
	readonly envVar: string;
	readonly keyDescription: string;
	readonly allowsNull: boolean;
}

export interface FileAttachmentKind extends ArmAttachmentKindBase {
	readonly delivery: "rules-dir";
}

export type ArmAttachmentKind = MappingAttachmentKind | FileAttachmentKind;

export const ARM_ATTACHMENT_KINDS: readonly ArmAttachmentKind[] = [
	{
		suffix: ".sections.yml",
		field: "sections",
		stagedDir: "sections",
		delivery: "env-json",
		envVar: "VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS",
		keyDescription: "section -> replacement text",
		allowsNull: false,
	},
	{
		suffix: ".statements.yml",
		field: "statements",
		stagedDir: "statements",
		delivery: "env-json",
		envVar: "VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS",
		keyDescription: "statement id -> replacement text (or null to ablate the statement)",
		allowsNull: true,
	},
	{
		suffix: ".prompts.yml",
		field: "prompts",
		stagedDir: "prompts",
		delivery: "env-json",
		envVar: "VEYYON_EVAL_PROMPTS",
		keyDescription: "prompt id -> replacement text",
		allowsNull: false,
	},
	{
		suffix: ".rule.md",
		field: "rule",
		stagedDir: "rules",
		delivery: "rules-dir",
	},
];

export const ARM_ATTACHMENT_SUFFIXES: readonly string[] = ARM_ATTACHMENT_KINDS.filter(kind =>
	kind.suffix.endsWith(".yml"),
).map(kind => kind.suffix);

export function attachmentKindOf(name: string): ArmAttachmentKind | undefined {
	return ARM_ATTACHMENT_KINDS.find(kind => name.endsWith(kind.suffix));
}

export type ArmAttachmentValues = { -readonly [K in keyof Omit<ArmInputs, "config">]?: ArmInputs[K] };

export type ArmAttachmentPayload = { readonly mapping: Record<string, string | null> } | { readonly bytes: Uint8Array };

export type ArmAttachmentRead =
	| { readonly present: false }
	| { readonly present: true; readonly payload: ArmAttachmentPayload }
	| { readonly error: string };

export function isArmAttachmentError(read: ArmAttachmentRead): read is { readonly error: string } {
	return "error" in read;
}

export function mappingOf(payload: ArmAttachmentPayload): Record<string, string | null> | undefined {
	return "mapping" in payload ? payload.mapping : undefined;
}

export function readArmAttachment(
	kind: ArmAttachmentKind,
	armsDir: string,
	arm: string,
	configArm: string,
): ArmAttachmentRead {
	const file = path.join(armsDir, `${configArm}${kind.suffix}`);
	if (!fs.existsSync(file)) return { present: false };
	if (kind.delivery === "rules-dir") return { present: true, payload: { bytes: fs.readFileSync(file) } };

	let parsed: unknown;
	try {
		parsed = YAML.parse(fs.readFileSync(file, "utf8")) ?? {};
	} catch (err) {
		return { error: `arm "${arm}" has invalid YAML in arms/${configArm}${kind.suffix}:\n${err}` };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {
			error:
				`arm "${arm}" arms/${configArm}${kind.suffix} must be a mapping of ${kind.keyDescription}, ` +
				`got ${Array.isArray(parsed) ? "a sequence" : parsed === null ? "null" : typeof parsed}.`,
		};
	}
	for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof value === "string") continue;
		if (kind.allowsNull && value === null) continue;
		return {
			error:
				`arm "${arm}" arms/${configArm}${kind.suffix} value for "${id}" must be text` +
				`${kind.allowsNull ? ", or null to ablate the statement" : ""}, got ${value === null ? "null" : typeof value}.`,
		};
	}
	return { present: true, payload: { mapping: parsed as Record<string, string | null> } };
}

export interface ArmAttachmentManifestEntry {
	readonly kind: string;
	readonly file: string;
	readonly delivery: ArmAttachmentDelivery;
	readonly envVar?: string;
}

export interface ArmAttachmentManifest {
	readonly version: 1;
	readonly arms: Readonly<Record<string, readonly ArmAttachmentManifestEntry[]>>;
}

export const ARM_ATTACHMENT_MANIFEST_VERSION = 1;
export const ARM_ATTACHMENT_MANIFEST_FILE = "attachments.json";

export function stageArmAttachment(
	kind: ArmAttachmentKind,
	assetsDir: string,
	arm: string,
	payload: ArmAttachmentPayload,
): ArmAttachmentManifestEntry {
	const extension = kind.delivery === "env-json" ? ".json" : ".md";
	const relative = path.join(kind.stagedDir, `${arm}${extension}`);
	fs.mkdirSync(path.join(assetsDir, kind.stagedDir), { recursive: true });
	fs.writeFileSync(
		path.join(assetsDir, relative),
		"mapping" in payload ? JSON.stringify(payload.mapping) : payload.bytes,
	);
	return {
		kind: kind.field,
		file: relative,
		delivery: kind.delivery,
		...(kind.delivery === "env-json" ? { envVar: kind.envVar } : {}),
	};
}

export function writeArmAttachmentManifest(
	assetsDir: string,
	entriesByArm: ReadonlyMap<string, readonly ArmAttachmentManifestEntry[]>,
): void {
	const arms: Record<string, readonly ArmAttachmentManifestEntry[]> = {};
	for (const [arm, entries] of [...entriesByArm].sort(([left], [right]) => left.localeCompare(right))) {
		arms[arm] = entries;
	}
	const manifest: ArmAttachmentManifest = { version: ARM_ATTACHMENT_MANIFEST_VERSION, arms };
	fs.mkdirSync(assetsDir, { recursive: true });
	fs.writeFileSync(path.join(assetsDir, ARM_ATTACHMENT_MANIFEST_FILE), `${JSON.stringify(manifest, null, "\t")}\n`);
}
