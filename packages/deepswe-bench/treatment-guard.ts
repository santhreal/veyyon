/**
 * Treatment-applies guard for argot encode arms.
 *
 * An arm that sets `argot.enabled: true` with a non-empty `argot.models`
 * allowlist is asserting an ENCODE treatment: the model is taught the notation
 * and gated in to write handles. But argot only encodes for a model that is
 * actually on the allowlist (see argot's `shouldEncode`/`modelAllowed`). If the
 * bench runs such an arm against a `--model` the allowlist does not name, the
 * gate quietly returns "do not encode": the codec still loads and `argot_load`
 * still works, but the preamble is never taught and no handle is ever written.
 * The arm SILENTLY becomes the decode-only condition while still being labelled
 * "full encode". Every delta attributed to encoding is then measuring nothing.
 *
 * That is a Law-10 silent fallback living inside the eval set itself, and it is
 * exactly the class of mistake that makes a benchmark lie. This module lets the
 * runner refuse to launch such an arm, using argot's OWN {@link modelAllowed}
 * predicate so the check can never drift from the gate the runtime applies.
 *
 * The pre-run {@link encodeArmModelMismatch} guard is necessary but NOT sufficient:
 * it matches the REQUESTED `--model` string, but the runtime resolves that id
 * through the catalog (provider aliases, effort-tier collapsing) to a different
 * logical id before the gate runs. This is not hypothetical: `google-antigravity`
 * used to alias `gemini-3.6-flash` onto the 3.5 flash family, so a run requesting
 * 3.6 passed this guard (3.6 was on the list) yet failed the gate (the resolved
 * 3.5 was not) and silently ran decode-only. That alias has been removed, but the
 * gap it exposed is permanent: any future alias, effort collapse, or provider
 * rename reopens it, because this guard cannot see a resolution that has not
 * happened yet. The authoritative check is therefore POST-RUN:
 * {@link encodePreambleSilentlyDropped} reads whether the encode preamble actually
 * reached the model (see aggregate's `systemPromptTeachesArgot`), which reflects
 * the model AFTER resolution and catches exactly that degrade. Run both.
 */

import { modelAllowed } from "argot";

/**
 * Inspect an arm's parsed config and decide whether it is an encode arm whose
 * allowlist excludes the model under test.
 *
 * Returns the offending allowlist (so the caller can name it in the error) when
 * the arm turns encoding on with a non-empty allowlist that no entry matches the
 * model. Returns `null` when the arm is sound for this model, which covers every
 * benign shape:
 *   - not an object / no `argot` block  → nothing to check.
 *   - `argot.enabled` not exactly `true` → encoding is off; the allowlist, if
 *     any, is inert.
 *   - `argot.models` missing or empty    → decode-only BY DESIGN (this is what
 *     `arms/decode.yml` is), not a silent degrade.
 *   - some allowlist entry matches the model → the treatment genuinely applies.
 *
 * Matching is delegated to argot's {@link modelAllowed}: a bare entry
 * (`gemini-3.6-flash`) is a provider wildcard matching the id's last segment; a
 * provider-qualified entry (`google-antigravity/gemini-3.6-flash`) matches only
 * its exact id. There is no fuzzy match, which is precisely why an operator's
 * bare list can miss a provider-qualified `--model` and why this guard exists.
 */
export function encodeArmModelMismatch(config: unknown, model: string): string[] | null {
	if (typeof config !== "object" || config === null) return null;
	const argotBlock = (config as Record<string, unknown>).argot;
	if (typeof argotBlock !== "object" || argotBlock === null) return null;
	const block = argotBlock as Record<string, unknown>;
	if (block.enabled !== true) return null;
	const models = block.models;
	if (!Array.isArray(models) || models.length === 0) return null;
	const allowlist = models.map(entry => String(entry));
	if (allowlist.some(entry => modelAllowed(entry, model))) return null;
	return allowlist;
}

/**
 * Whether an arm's parsed config declares an ENCODE treatment: `argot.enabled`
 * exactly `true` AND a non-empty `argot.models` allowlist. This is the same shape
 * {@link encodeArmModelMismatch} keys on, factored out so the post-run check can
 * ask "should this arm have taught the preamble?" without re-deriving the shape.
 * A decode-only arm (`argot.models: []`) is deliberately NOT an encode arm and is
 * expected to never teach the preamble, so it must not trip the post-run guard.
 */
export function isEncodeArm(config: unknown): boolean {
	if (typeof config !== "object" || config === null) return false;
	const argotBlock = (config as Record<string, unknown>).argot;
	if (typeof argotBlock !== "object" || argotBlock === null) return false;
	const block = argotBlock as Record<string, unknown>;
	if (block.enabled !== true) return false;
	const models = block.models;
	return Array.isArray(models) && models.length > 0;
}

/**
 * The authoritative POST-RUN treatment check for an encode arm, complementing the
 * pre-run {@link encodeArmModelMismatch}. Given the per-trial "was the encode
 * preamble taught" flags for one encode arm's OK (non-errored) trials, decide
 * whether the treatment SILENTLY DROPPED: at least one trial's presence is known
 * and EVERY known trial failed to teach the preamble.
 *
 * Why this exists even though a pre-run guard already runs: the pre-run guard
 * matches the requested `--model` against the allowlist, but the runtime resolves
 * that id through the catalog (provider aliases, effort-tier collapsing) to a
 * different logical id before argot's gate sees it. A requested id can pass the
 * allowlist yet the RESOLVED id fail it, so an arm labelled "full encode" runs
 * decode-only and every token delta against it measures nothing. Reading whether
 * the preamble actually reached the model catches that; the requested-id guard
 * cannot.
 *
 * Returns `false` (not a failure) when no trial's presence is known — an
 * unreadable session is a separate problem, not evidence the treatment dropped —
 * and when at least one known trial DID teach the preamble. A partial fire (some
 * taught, some not) is deliberately NOT a failure here: argot's own context-size
 * cutoff can legitimately disable encoding on longer trials, so partial firing is
 * surfaced in the report but does not fail the run closed.
 */
export function encodePreambleSilentlyDropped(preambleFlags: readonly (boolean | null)[]): boolean {
	const known = preambleFlags.filter((f): f is boolean => f !== null);
	return known.length > 0 && known.every(f => f === false);
}

/**
 * Every dotted path in an arm's config that the settings schema does not know.
 *
 * WHY THIS EXISTS. An arm is a config overlay, and nothing else. A key veyyon
 * does not recognise is not an error anywhere: the overlay is merged, the
 * unknown key sits there unread, and the arm runs with default behaviour under
 * a name that claims a treatment. The report then compares the control against
 * a second copy of the control and calls the difference noise, which is the
 * most expensive possible way to be wrong, because the answer looks like a real
 * measurement.
 *
 * That is the same defect class as the argot allowlist mismatch above, one
 * layer up: there, a real setting failed to apply; here, the setting was never
 * a setting. `tools.discoveryMode`, `tools.inlineOutputFloor` and every future
 * knob reach the container this way, so one typo silently voids the experiment.
 * A renamed or removed setting does the same thing later, without anyone
 * touching the arm.
 *
 * `isKnownPath` is a parameter so this stays a pure function with tests that do
 * not load the schema. The runner passes the real one.
 *
 * Both YAML spellings are accepted, because both are in use across `arms/`:
 * nested (`tools:` then `inlineOutputFloor: 0.1`) and flat
 * (`tools.inlineOutputFloor: 0.1`). Descent stops as soon as a prefix is itself
 * a known setting, so a record-valued setting like `tools.approval` keeps its
 * arbitrary keys instead of having each one reported as unknown.
 *
 * Returns the offending paths sorted, most specific first in the sense that a
 * leaf is named rather than its parent, so the error can quote what to fix.
 */
export function unknownArmSettings(config: unknown, isKnownPath: (path: string) => boolean): string[] {
	const unknown: string[] = [];
	const walk = (node: unknown, prefix: string): void => {
		const isMapping = node !== null && typeof node === "object" && !Array.isArray(node);
		if (!isMapping) {
			if (prefix !== "") unknown.push(prefix);
			return;
		}
		const entries = Object.entries(node as Record<string, unknown>);
		// An empty mapping under an unrecognised prefix has no leaf to name, so
		// report the prefix. Descending silently would let `nonsense: {}` pass.
		if (entries.length === 0) {
			if (prefix !== "") unknown.push(prefix);
			return;
		}
		for (const [key, value] of entries) {
			const path = prefix === "" ? key : `${prefix}.${key}`;
			if (isKnownPath(path)) continue;
			walk(value, path);
		}
	};
	walk(config, "");
	return unknown.sort();
}

/** What the settings schema says a path holds. */
export interface ArmSettingType {
	/** The schema's declared kind: "boolean", "number", "string", "enum", "array", "record". */
	readonly kind: string;
	/** Permitted values, for an enum. */
	readonly values?: readonly string[];
}

/** A key whose value the schema would not accept, and why. */
export interface MistypedArmSetting {
	readonly path: string;
	readonly expected: string;
	readonly actual: string;
}

/**
 * Every key in an arm whose VALUE the settings schema would reject.
 *
 * The sibling of {@link unknownArmSettings}, and it exists because the key
 * check is only half the question. `tools.discoveryMode: yes` names a real
 * setting, so it passes that check, and then YAML parses the bare word as the
 * boolean `true` while the schema wants one of a fixed set of strings. The
 * overlay merges, the value is not usable, and the arm runs as the control
 * under a treatment's name: exactly the same silent-null-result failure, from a
 * mistake nothing else can catch.
 *
 * YAML makes this easy to hit rather than exotic. Bare `yes`, `no`, `on` and
 * `off` are booleans, `0.1` is a number but `.1` is a string, and a quoted
 * `"0.1"` is a string that looks identical in a diff.
 *
 * `typeOf` returns the schema's declared type for a path, or undefined for a
 * path it does not know. Unknown paths are skipped rather than reported here,
 * because {@link unknownArmSettings} already owns that message and reporting a
 * typo twice, once as unknown and once as mistyped, helps nobody.
 */
export function mistypedArmSettings(
	config: unknown,
	typeOf: (path: string) => ArmSettingType | undefined,
): MistypedArmSetting[] {
	const problems: MistypedArmSetting[] = [];
	const walk = (node: unknown, prefix: string): void => {
		const declared = prefix === "" ? undefined : typeOf(prefix);
		if (declared !== undefined) {
			const problem = describeMismatch(declared, node);
			if (problem !== undefined) problems.push({ path: prefix, ...problem });
			return;
		}
		if (node === null || typeof node !== "object" || Array.isArray(node)) return;
		for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
			walk(value, prefix === "" ? key : `${prefix}.${key}`);
		}
	};
	walk(config, "");
	return problems.sort((a, b) => a.path.localeCompare(b.path));
}

/** The `expected`/`actual` pair for a value the schema would reject, or undefined when it is fine. */
function describeMismatch(declared: ArmSettingType, value: unknown): Omit<MistypedArmSetting, "path"> | undefined {
	const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
	switch (declared.kind) {
		case "boolean":
			return actual === "boolean" ? undefined : { expected: "boolean", actual };
		case "number":
			// A non-finite number is as unusable as a string here, and YAML's `.inf`
			// and `.nan` both parse to one.
			return typeof value === "number" && Number.isFinite(value) ? undefined : { expected: "number", actual };
		case "string":
			return actual === "string" ? undefined : { expected: "string", actual };
		case "enum": {
			const allowed = declared.values ?? [];
			if (typeof value === "string" && allowed.includes(value)) return undefined;
			return {
				expected: `one of ${allowed.join(", ")}`,
				actual: actual === "string" ? `"${String(value)}"` : actual,
			};
		}
		case "array":
			return Array.isArray(value) ? undefined : { expected: "array", actual };
		case "record":
			return value !== null && typeof value === "object" && !Array.isArray(value)
				? undefined
				: { expected: "record", actual };
		default:
			// A kind this function has not been taught is not an error to report: it
			// would fail every arm that uses the setting. Adding a kind to the schema
			// should not break the bench.
			return undefined;
	}
}
