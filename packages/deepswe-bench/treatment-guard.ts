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
