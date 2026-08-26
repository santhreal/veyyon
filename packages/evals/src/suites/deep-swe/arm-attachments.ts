/**
 * Everything an arm can carry besides its config, declared once.
 *
 * An arm is a config overlay (`arms/<arm>.yml`). Four things it may also carry are not
 * config at all, because no config key may reach a prompt: a section body override, a
 * statement override, a registered-prompt override, and an always-apply rule file. Each
 * is read from `arms/`, staged next to the binary, delivered into the container, and
 * folded into the arm's fingerprint.
 *
 * WHY A TABLE AND NOT FOUR BLOCKS. Each kind used to be spelled out in five places: the
 * suffix list, ~30 lines of parse-and-stage in `run.ts`, the fingerprint field, and
 * three separate spots in `pier_agent/veyyon_agent.py` (upload, env prefix, command
 * prefix). Nine edits for one kind, with no failure if one was missed — the attachment
 * was then either read as a config overlay (a phantom arm) or silently ignored, and an
 * ignored treatment is benched as its control under the treatment's name. Now a kind is
 * one row here: `run.ts` loops over the table, `arm-fingerprint.ts` derives its suffix
 * list from it, and the container side reads {@link ArmAttachmentManifest}, which this
 * module writes, instead of naming any kind at all.
 *
 * THE DELIVERY IS PART OF THE ROW. An id-keyed override rides an eval-only env var, so
 * that no config key can reach it and a normal session cannot see it. A rule file is a
 * context file copied into the container's rules directory, because that is how a rule
 * reaches a session at all. Those are the two deliveries; a kind names one.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord } from "@veyyon/utils";
import YAML from "yaml";
import type { ArmInputs } from "./arm-fingerprint";

/** How a staged attachment reaches the agent inside the container. */
export type ArmAttachmentDelivery = "env-json" | "rules-dir";

interface ArmAttachmentKindBase {
	/** The `arms/<arm>` filename suffix that carries it. */
	readonly suffix: string;
	/**
	 * The {@link ArmInputs} field it fingerprints as, and its identity in the manifest.
	 *
	 * Typed against `ArmInputs` so a row for a field the fingerprint does not hash cannot
	 * be declared: that combination is the silent one, an arm carrying a real treatment
	 * that collides with its control as zero-IV and is dropped as a duplicate.
	 */
	readonly field: keyof Omit<ArmInputs, "config">;
	/** The directory under `<out>/assets` its staged copy is written to. */
	readonly stagedDir: string;
}

/** An id-keyed override: YAML mapping in, JSON out, delivered as an environment variable. */
export interface MappingAttachmentKind extends ArmAttachmentKindBase {
	readonly delivery: "env-json";
	/** The eval-only environment variable the agent reads it through. */
	readonly envVar: string;
	/** What the mapping's keys are, for a refusal an operator can act on. */
	readonly keyDescription: string;
	/**
	 * Whether `null` is a legal value.
	 *
	 * Only a statement allows it, and it is the whole point of that kind: `null` ablates
	 * the rule, which an empty string cannot express ("this rule says nothing but is
	 * still here" is a different prompt).
	 */
	readonly allowsNull: boolean;
}

/** A context file: bytes in, bytes out, copied into the container's rules directory. */
export interface FileAttachmentKind extends ArmAttachmentKindBase {
	readonly delivery: "rules-dir";
}

export type ArmAttachmentKind = MappingAttachmentKind | FileAttachmentKind;

/**
 * Every attachment kind, in the order a reader meets them: coarse to fine, then the rule.
 *
 * A section is one banner-delimited region of the system prompt. A statement is one rule
 * inside one, which is the vehicle an ablation needs, since TOOL POLICY is 34 rules in
 * one region and no score change across it can be attributed to a cause. A prompt is a
 * whole registered document — a tool description, a subagent prompt, an agent prompt —
 * the only vehicle that reaches text outside the system prompt. A rule is not a prompt
 * override at all: it is a context file the session loads, which is how a behavioural
 * instruction that no shipped prompt contains gets in front of the model.
 */
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

/**
 * The suffixes that make an `arms/*.yml` file an attachment rather than an arm.
 *
 * Only the YAML kinds: `armSelectionError` and `isArmConfigFile` answer "is this `.yml`
 * an arm", and `.rule.md` is not a `.yml` at all, so including it would have those
 * functions testing a suffix no candidate can carry.
 */
export const ARM_ATTACHMENT_SUFFIXES: readonly string[] = ARM_ATTACHMENT_KINDS.filter(kind =>
	kind.suffix.endsWith(".yml"),
).map(kind => kind.suffix);

/** The kind a filename carries, or `undefined` when the file is an arm config. */
export function attachmentKindOf(name: string): ArmAttachmentKind | undefined {
	return ARM_ATTACHMENT_KINDS.find(kind => name.endsWith(kind.suffix));
}

/**
 * What one arm carries, keyed by fingerprint field, as the runner accumulates it.
 *
 * Mutable and partial because the runner fills it one kind at a time, while `ArmInputs`
 * is the frozen thing it fingerprints; the mapped type keeps the two in step, so a field
 * renamed there cannot silently stop being staged here.
 */
export type ArmAttachmentValues = { -readonly [K in keyof Omit<ArmInputs, "config">]?: ArmInputs[K] };

/** The mapping or the bytes an attachment holds, by delivery. */
export type ArmAttachmentPayload = { readonly mapping: Record<string, string | null> } | { readonly bytes: Uint8Array };

/**
 * Reading an attachment: absent, its payload, or the one thing wrong with it.
 *
 * A result rather than a `process.exit` because `run.ts` ends in a top-level
 * `await main()`, so anything that has to be imported to be tested cannot live there.
 * The runner turns an `error` into the exit; this module decides what is wrong.
 */
export type ArmAttachmentRead =
	| { readonly present: false }
	| { readonly present: true; readonly payload: ArmAttachmentPayload }
	| { readonly error: string };

/** Whether a read failed, narrowing for a caller that only wants to print and exit. */
export function isArmAttachmentError(read: ArmAttachmentRead): read is { readonly error: string } {
	return "error" in read;
}

/** The mapping a read produced, or `undefined` for a file-delivered kind. */
export function mappingOf(payload: ArmAttachmentPayload): Record<string, string | null> | undefined {
	return "mapping" in payload ? payload.mapping : undefined;
}

/**
 * Parse and validate one attachment of one arm.
 *
 * Values are checked HERE, in the runner, as well as in the agent that consumes them.
 * That is not redundant: a bad payload is cheap to catch before a container starts and
 * expensive to discover after paying for a run, because the agent refuses it identically
 * in every trial of the arm and the whole arm hard-errors at zero output tokens.
 *
 * @param armsDir the `arms/` directory to read from
 * @param arm the arm as named on the command line, used in messages
 * @param configArm the arm whose files are read, which differs from `arm` for a repeated arm
 */
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
	if (!isRecord(parsed)) {
		return {
			error:
				`arm "${arm}" arms/${configArm}${kind.suffix} must be a mapping of ${kind.keyDescription}, ` +
				`got ${Array.isArray(parsed) ? "a sequence" : parsed === null ? "null" : typeof parsed}.`,
		};
	}
	for (const [id, value] of Object.entries(parsed)) {
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

/** One staged attachment, as the container side reads it. */
export interface ArmAttachmentManifestEntry {
	/** The kind's identity, matching its {@link ArmInputs} field. */
	readonly kind: string;
	/** The staged file, relative to the assets directory. */
	readonly file: string;
	readonly delivery: ArmAttachmentDelivery;
	/** Present for `env-json` only: the variable that carries the file's bytes. */
	readonly envVar?: string;
}

/**
 * What the runner staged, per arm.
 *
 * WHY A MANIFEST AND NOT A CONVENTION. The container side used to look for each kind by
 * name — `sections/<arm>.json`, `statements/<arm>.json`, `prompts/<arm>.json`,
 * `rules/<arm>.md` — in three places per kind, so a fifth kind meant editing Python that
 * nothing typechecks and no test covers. It now reads this file and handles whatever it
 * lists, which is why adding a kind is one row in {@link ARM_ATTACHMENT_KINDS}.
 *
 * `version` is what makes a stale copy loud. An assets directory outlives the run that
 * wrote it (it is hashed into the run's provenance and kept), so a shape change has to be
 * a refusal rather than a misread: the reader rejects a version it does not know.
 */
export interface ArmAttachmentManifest {
	readonly version: 1;
	readonly arms: Readonly<Record<string, readonly ArmAttachmentManifestEntry[]>>;
}

export const ARM_ATTACHMENT_MANIFEST_VERSION = 1;
export const ARM_ATTACHMENT_MANIFEST_FILE = "attachments.json";

/**
 * Write the exact bytes the container will read, and return the manifest entry for it.
 *
 * Staged per arm rather than per trial, and compact so two runs of one arm produce
 * identical bytes: the assets directory is hashed into the run's provenance, and a
 * whitespace difference there would read as a changed treatment. `null` survives
 * `JSON.stringify`, which is what keeps ablation expressible.
 */
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

/**
 * Write the manifest, always, including for a run whose arms carry nothing.
 *
 * An absent manifest and an empty one are different facts, and the container side has to
 * tell them apart: absent means a runner too old to write one, which is a stale assets
 * directory and a refusal; empty means this arm carries no attachment, which is the
 * ordinary case for a baseline.
 */
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
