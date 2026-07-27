/**
 * Arm input fingerprinting for the single-independent-variable guard.
 *
 * A bench comparison MUST vary exactly one independent variable between arms
 * (README, "Single Independent Variable Rule"). The mechanical floor of that
 * rule is that no two arms may reduce to the same input: if two arms parse to
 * the same config and carry the same (or no) `.rule.md`, the "comparison"
 * varies ZERO variables and every reported delta is pure sampling noise. That
 * is the classic silent no-op arm — a `candidate-vN` copied from `baseline`
 * with only its comment header changed — and it silently produced result-shaped
 * tables with no attributable cause. This module makes that case detectable so
 * the runner can fail loudly instead.
 *
 * The fingerprint is SEMANTIC, not byte-level: the arm's `.yml` is compared as
 * PARSED config, so a different comment, key order, or quoting style — none of
 * which reach the agent — does not disguise two identical arms as distinct. A
 * per-section prompt experiment lives in a SEPARATE `arms/<arm>.sections.yml`
 * file (delivered to the agent only through the eval-only
 * `VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS` env var, never through config), parsed to
 * an object and compared the same semantic way. The `.rule.md` is prompt text,
 * so it is compared as raw bytes (its whitespace is significant).
 *
 * The logic lives here (not inline in run.ts) so it is unit-testable: run.ts
 * ends in a top-level `await main()`, so importing it would execute a bench.
 */

import { createHash } from "node:crypto";

/**
 * What one arm reduces to: its parsed config overlay, an optional per-section
 * prompt override, and at most one always-apply rule. Whole-prompt replacement
 * and append are not bench vehicles — they freeze a snapshot that stops
 * responding to settings and can silently drop a settings-gated section. A
 * per-section prompt experiment rides in `sections` (an eval-only override, not
 * config) so it swaps exactly one banner region and leaves every setting-gated
 * block intact.
 */
export interface ArmInputs {
	/** The arm's `.yml` overlay after `YAML.parse` (comments and formatting gone). */
	readonly config: unknown;
	/** The arm's `.sections.yml` after parse, if any: `section -> replacement text`. */
	readonly sections?: unknown;
	/**
	 * The arm's `.statements.yml` after parse, if any: `statement id -> replacement text, or null`.
	 *
	 * The finer vehicle, and the one an ablation needs: a section override answers "is this section
	 * worth its tokens", which for TOOL POLICY is 9KB and 34 rules at once, so no score change can be
	 * attributed to a cause. `null` removes exactly one rule.
	 */
	readonly statements?: unknown;
	/** Optional always-apply rule bytes; prompt text, so whitespace-significant. */
	readonly rule?: Uint8Array;
}

/**
 * Stable, key-sorted JSON of an arbitrary parsed value. Object keys are sorted
 * so key order never affects the result; array order is preserved because it is
 * semantically meaningful (e.g. a fallback chain). Two configs that differ only
 * in key order, quoting, or YAML comments canonicalize identically.
 */
export function canonicalizeConfig(value: unknown): string {
	return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortDeep);
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(record)
				.sort()
				.map(key => [key, sortDeep(record[key])]),
		);
	}
	return value;
}

/**
 * The suffixes that make an `arms/` file an ATTACHMENT to an arm rather than an arm.
 *
 * WHY THIS IS DECLARED ONCE. "Which files in `arms/` are arms" was answered in three places and one of
 * them was wrong: `docs-coherence.test.ts` took every `*.yml`, so `candidate-delivery-terse.sections.yml`
 * became a phantom arm named `candidate-delivery-terse.sections`, while the other two enumerators
 * excluded it. A phantom arm is not cosmetic here, because these lists are what the coherence checks
 * quantify over: an arm nobody can run reads as an arm nobody documented.
 *
 * Adding `.statements.yml` made the duplication urgent rather than merely untidy, since a third suffix
 * would have had to be added to three places to avoid inventing a second phantom.
 */
export const ARM_ATTACHMENT_SUFFIXES: readonly string[] = [".sections.yml", ".statements.yml"];

/** Whether an `arms/` filename is an arm's config, as opposed to an attachment to one. */
export function isArmConfigFile(name: string): boolean {
	return name.endsWith(".yml") && !ARM_ATTACHMENT_SUFFIXES.some(suffix => name.endsWith(suffix));
}

/** The arm names in a directory listing, sorted, with attachments excluded. */
export function armNamesIn(files: readonly string[]): string[] {
	return files
		.filter(isArmConfigFile)
		.map(name => name.slice(0, -".yml".length))
		.sort();
}

/**
 * Why a requested arm cannot be benched, or `null` when it can.
 *
 * A pure function rather than an inline check in `run.ts`, for the reason the header gives: `run.ts`
 * ends in a top-level `await main()`, so importing it to test anything executes a bench. The two
 * refusals here are both ones an operator hits by typing, and both used to surface badly.
 *
 * A misspelled arm reached `readFileSync` and died with a raw ENOENT stack, which reads as a broken
 * runner rather than as a typo, and buried the only useful fact: what the arms are called. An
 * ATTACHMENT name is worse than that, because it does NOT fail: `--arms candidate-delivery-terse.sections`
 * finds `candidate-delivery-terse.sections.yml`, parses a section-override map as a config overlay,
 * merges keys veyyon has never heard of, and benches the control under a treatment's name.
 */
export function armSelectionError(arm: string, available: readonly string[]): string | null {
	const attachment = ARM_ATTACHMENT_SUFFIXES.find(suffix => `${arm}.yml`.endsWith(suffix));
	if (attachment !== undefined) {
		const real = arm.slice(0, -(attachment.length - ".yml".length));
		return (
			`"${arm}" is not an arm, it is the ${attachment} attachment of arm "${real}".\n` +
			`Fix: bench the arm itself (--arms ${real}); its ${attachment} is applied automatically.`
		);
	}
	if (!available.includes(arm)) {
		return `no arm "${arm}" in arms/.\nAvailable arms: ${available.join(", ")}`;
	}
	return null;
}

/**
 * A stable content fingerprint of everything the container sees for an arm.
 * Two arms fingerprint equal iff their canonical config, canonical section
 * override, canonical statement override AND rule bytes are all identical. Each field is length-prefixed so
 * the encoding is injective: a plain-concatenation scheme is ambiguous (config
 * text ending in the rule's bytes could hash the same as a separate rule),
 * whereas prefixing every field's byte length makes the tuple unambiguous. A
 * missing section override and an empty-object one collapse to the same
 * canonical `{}`, which is correct: neither changes any prompt section.
 */
export function computeArmFingerprint(mod: ArmInputs): string {
	const h = createHash("sha256");
	const field = (label: string, bytes: Uint8Array): void => {
		h.update(`${label}:${bytes.length}\n`);
		h.update(bytes);
	};
	field("config", new TextEncoder().encode(canonicalizeConfig(mod.config)));
	field("sections", new TextEncoder().encode(canonicalizeConfig(mod.sections ?? {})));
	// The statement override is folded in ONLY when it says something, which is two properties at once
	// and both are needed. An arm with no statement override, or with an empty one, fingerprints
	// exactly as it did before this field existed, so the fingerprints already recorded in past results
	// stay comparable and a longitudinal diff does not report every arm as changed. And an EMPTY
	// override canonicalizes to `{}` and is therefore treated as absent, so an arm carrying an empty
	// file cannot pass the single-IV guard by looking different from an identical arm without one.
	const statements = canonicalizeConfig(mod.statements ?? {});
	if (statements !== "{}") field("statements", new TextEncoder().encode(statements));
	if (mod.rule !== undefined) field("rule", mod.rule);
	return h.digest("hex");
}

/**
 * Groups of arms whose staged inputs reduce to the same thing. Each returned
 * group has length >= 2 and names arms that fingerprint the same; an empty
 * result means every arm differs from every other (the required single-IV
 * floor). Arms that appear once — the normal case — are never returned.
 */
export function findZeroIvCollisions(fingerprints: Map<string, string>): string[][] {
	const byPrint = new Map<string, string[]>();
	for (const [arm, fp] of fingerprints) {
		const group = byPrint.get(fp);
		if (group) group.push(arm);
		else byPrint.set(fp, [arm]);
	}
	return [...byPrint.values()].filter(group => group.length > 1);
}
