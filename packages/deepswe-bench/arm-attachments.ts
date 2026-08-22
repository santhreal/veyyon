/**
 * The prompt-override attachments an arm can carry, declared once.
 *
 * An arm is a config overlay (`arms/<arm>.yml`). Three things it may also carry are not
 * config at all, because no config key may reach a prompt: a section body override, a
 * statement override, and a registered-prompt override. Each rides to the container as
 * an eval-only env var, each is staged as JSON next to the binary, and each must be
 * folded into the arm's fingerprint or the single-IV floor cannot see it.
 *
 * WHY A TABLE AND NOT THREE BLOCKS. The three were 30 near-identical lines each in
 * `run.ts` — parse YAML, refuse a non-mapping, refuse a bad value, mkdir, write JSON —
 * and adding a kind meant editing the suffix list, the fingerprint, the arm-selection
 * guard and the runner, with a phantom arm or a silently ignored attachment as the
 * penalty for missing one. `arm-attachment-kinds.test.ts` was written to police exactly
 * that duplication. With the table, a kind is one row and the sweep in that suite
 * quantifies over the row rather than over a list somebody remembered to update.
 *
 * `arms/<arm>.rule.md` is deliberately NOT here. It is a context file copied as bytes
 * into the container's project tree, not an id-keyed JSON override read from an env var,
 * so it shares neither the parse, the validation, nor the staged shape.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import type { ArmInputs } from "./arm-fingerprint";

/** One kind of prompt-override attachment: how it is spelled, checked, staged and delivered. */
export interface ArmAttachmentKind {
	/** The `arms/<arm>` filename suffix that carries it. */
	readonly suffix: string;
	/**
	 * The {@link ArmInputs} field it fingerprints as.
	 *
	 * Typed against `ArmInputs` so a row for a field the fingerprint does not hash cannot
	 * be declared: that combination is the silent one, an arm carrying a real treatment
	 * that collides with its control as zero-IV.
	 */
	readonly field: keyof Omit<ArmInputs, "config" | "rule">;
	/** The directory under `<out>/assets` its staged JSON is written to. */
	readonly stagedDir: string;
	/** The eval-only environment variable the agent reads it through, for messages and docs. */
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

/**
 * Every attachment kind, in the order a reader meets them: coarse to fine.
 *
 * A section is one banner-delimited region of the system prompt. A statement is one rule
 * inside one, which is the vehicle an ablation needs, since TOOL POLICY is 34 rules in
 * one region and no score change across it can be attributed to a cause. A prompt is a
 * whole registered document — a tool description, a subagent prompt, an agent prompt —
 * which is the only vehicle that reaches text outside the system prompt at all.
 */
export const ARM_ATTACHMENT_KINDS: readonly ArmAttachmentKind[] = [
	{
		suffix: ".sections.yml",
		field: "sections",
		stagedDir: "sections",
		envVar: "VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS",
		keyDescription: "section -> replacement text",
		allowsNull: false,
	},
	{
		suffix: ".statements.yml",
		field: "statements",
		stagedDir: "statements",
		envVar: "VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS",
		keyDescription: "statement id -> replacement text (or null to ablate the statement)",
		allowsNull: true,
	},
	{
		suffix: ".prompts.yml",
		field: "prompts",
		stagedDir: "prompts",
		envVar: "VEYYON_EVAL_PROMPTS",
		keyDescription: "prompt id -> replacement text",
		allowsNull: false,
	},
];

/** The suffixes that make an `arms/` file an attachment rather than an arm. */
export const ARM_ATTACHMENT_SUFFIXES: readonly string[] = ARM_ATTACHMENT_KINDS.map(kind => kind.suffix);

/** The kind a filename carries, or `undefined` when the file is an arm config. */
export function attachmentKindOf(name: string): ArmAttachmentKind | undefined {
	return ARM_ATTACHMENT_KINDS.find(kind => name.endsWith(kind.suffix));
}

/**
 * Reading an attachment: the parsed mapping, or the one thing wrong with it.
 *
 * A result rather than a `process.exit` because `run.ts` ends in a top-level
 * `await main()`, so anything that has to be imported to be tested cannot live there.
 * The runner turns an `error` into the exit; this module decides what is wrong.
 */
export type ArmAttachmentRead =
	| { readonly present: false }
	| { readonly present: true; readonly value: Record<string, string | null> }
	| { readonly error: string };

/** Whether a read failed, narrowing for a caller that only wants to print and exit. */
export function isArmAttachmentError(read: ArmAttachmentRead): read is { readonly error: string } {
	return "error" in read;
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
	return { present: true, value: parsed as Record<string, string | null> };
}

/**
 * Write the exact JSON bytes the env var will carry.
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
	value: Record<string, string | null>,
): void {
	const dir = path.join(assetsDir, kind.stagedDir);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${arm}.json`), JSON.stringify(value));
}
