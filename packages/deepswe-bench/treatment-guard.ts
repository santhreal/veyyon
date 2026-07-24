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
 * logical id before the gate runs. A requested `google-antigravity/gemini-3.6-flash`
 * that the catalog serves as logical `gemini-3.5-flash` passes this guard (3.6 is
 * on the list) yet fails the gate (the resolved 3.5 is not), so the arm silently
 * runs decode-only. The authoritative check is therefore POST-RUN:
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
