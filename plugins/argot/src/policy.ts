/**
 * Encode-side gating for argot.
 *
 * Argot has two directions with opposite rules. *Decoding* — `ArgotSession.expand`
 * turning a handle back into its full text — is unconditional: once a dictionary
 * is loaded it always runs, because a handle that reaches a tool or the disk
 * unexpanded is a broken path, not merely worse text. *Encoding* — teaching the
 * model the notation so it writes handles in the first place — is a policy
 * choice a harness may want to vary per model and per context size.
 *
 * This module owns that policy as one pure predicate, `shouldEncode`, so the
 * rule is the same in every harness and testable on its own. The harness
 * supplies the live inputs it measures each turn (which model is active, how
 * large the context is); the SDK decides. Decoding is never gated by anything
 * here.
 *
 * The two levers:
 *
 *   - **Model allowlist.** Only models you name may encode. An empty list means
 *     no model does, so turning the feature on without naming a model stays
 *     inert. This lets you keep shorthand off for models you have not yet
 *     trusted to use it reliably.
 *   - **Context cutoff.** Stop teaching shorthand once the context grows past a
 *     token threshold, so a large, recall-degraded context writes in full
 *     instead of risking a garbled handle. Handles already in the history still
 *     expand losslessly; only new encoding stops.
 */

/**
 * The operator-facing gate: which models may encode, and an optional
 * context-size cutoff. Build one from your settings and hold it for the session.
 */
export interface ArgotGate {
	/**
	 * Model identifiers permitted to encode. Each entry is matched against the
	 * active model id by {@link modelAllowed}: an entry matches when it is either
	 * the full provider-qualified id (`provider/model-id`) or just the model id
	 * (the segment after the last `/`). So a bare name like `gemini-2.5-flash`
	 * enables that model under any provider, while `openrouter/gemini-2.5-flash`
	 * stays specific to that provider. Matching is otherwise exact and
	 * case-sensitive; there is no substring or fuzzy fallback. An empty list means
	 * no model encodes — the safe default for an opt-in feature.
	 */
	readonly models: readonly string[];
	/**
	 * Stop encoding once the context reaches this many tokens. A value of `0` or
	 * less disables the cutoff, so encoding continues at any context size.
	 */
	readonly disableAboveTokens: number;
}

/** The live inputs a harness measures each turn and feeds to {@link shouldEncode}. */
export interface ArgotGateInput {
	/** The active model id, compared against {@link ArgotGate.models}. */
	readonly model: string;
	/**
	 * Current context size in tokens: the prompt tokens the model last saw. A
	 * harness that cannot measure this cheaply may pass `0`, which keeps encoding
	 * on until it has a real figure (a small context is never a reason to stop).
	 */
	readonly contextTokens: number;
}

/** The inert gate: no model listed, no cutoff. {@link shouldEncode} is always `false`. */
export const EMPTY_GATE: ArgotGate = { models: [], disableAboveTokens: 0 };

/** The settings a harness maps onto a gate: its allowlist and optional cutoff. */
export interface MakeGateOptions {
	/** Models permitted to encode; see {@link ArgotGate.models}. Omitted or empty means none. */
	readonly models?: readonly string[];
	/** Context-token cutoff; see {@link ArgotGate.disableAboveTokens}. Omitted means no cutoff. */
	readonly disableAboveTokens?: number;
}

/**
 * Build an {@link ArgotGate} from a harness's on/off flag and settings — the ONE
 * place the gate shape is constructed, so no harness hand-rolls the object literal
 * and drifts when a field is added here. When `enabled` is `false` the result is
 * {@link EMPTY_GATE} (inert: {@link shouldEncode} always `false`), regardless of any
 * options passed. When `enabled` is `true` the allowlist and cutoff are carried
 * through, each defaulting to its inert value (no models, no cutoff) so an enabled
 * gate with an empty allowlist still encodes nothing until a model is named.
 */
export function makeGate(enabled: boolean, options: MakeGateOptions = {}): ArgotGate {
	if (!enabled) {
		return EMPTY_GATE;
	}
	return {
		models: options.models ?? [],
		disableAboveTokens: options.disableAboveTokens ?? 0,
	};
}

/**
 * Decide whether to teach the model argot shorthand this turn.
 *
 * This gates only encoding — whether the harness injects the notation preamble
 * (or an inline handle fragment) so the model writes handles. It never affects
 * decoding: `ArgotSession.expand` still restores any handle already in the
 * history, whatever this returns. So it is always safe to stop encoding; the
 * worst case is the model writing full text, never a leaked handle.
 *
 * Returns `false` when no model is allowed, when the active model is not on the
 * list, or when the context has grown past the cutoff. Otherwise `true`.
 */
export function shouldEncode(gate: ArgotGate, input: ArgotGateInput): boolean {
	if (gate.models.length === 0) {
		return false;
	}
	if (!gate.models.some(entry => modelAllowed(entry, input.model))) {
		return false;
	}
	if (gate.disableAboveTokens > 0 && input.contextTokens >= gate.disableAboveTokens) {
		return false;
	}
	return true;
}

/**
 * Whether an allowlist entry names the active model.
 *
 * Runtime model ids are provider-qualified as `provider/model-id` (for example
 * `google-antigravity/gemini-2.5-flash`), but an operator naturally lists the
 * bare model name (`gemini-2.5-flash`) in their settings. So there are two kinds
 * of entry: a provider-qualified entry (one containing `/`) matches only its
 * exact id, staying specific to that provider; a bare entry (no `/`) is a
 * provider wildcard that matches when it equals the active id's model segment —
 * the part after the last `/`. There is no substring or fuzzy match: a bare
 * `flash` never matches `gemini-2.5-flash`.
 *
 * Exported so a caller that needs to know, ahead of a run, whether a given model
 * would be encoded under a gate can ask with the exact same predicate the runtime
 * uses, rather than re-deriving the matching rule and risking drift. The eval
 * harness uses this to refuse an encode arm whose allowlist would not match the
 * model under test (which would silently degrade the arm to decode-only).
 */
export function modelAllowed(entry: string, activeModel: string): boolean {
	if (entry.includes("/")) {
		return entry === activeModel;
	}
	return entry === modelIdSegment(activeModel);
}

/** The model-id segment of a possibly provider-qualified id: the part after the last `/`. */
export function modelIdSegment(id: string): string {
	const slash = id.lastIndexOf("/");
	return slash === -1 ? id : id.slice(slash + 1);
}
