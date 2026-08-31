/**
 * The failure vocabulary: one bit per failure kind, and the primitives that read a set of them.
 *
 * This module is a LEAF. It imports nothing from the classifier, the domains or the registry, which
 * is what lets `domains/*` name a flag at module scope without a cycle. Everything that decides
 * WHICH flags a failure carries lives in `domains/`, and everything that decides what to DO about
 * them lives in `registry.ts`.
 */

export const Flag = {
	Class: 0x1000,
	ThinkingLoop: 0x0001_0000,
	Transient: 0x0002_0000,
	Timeout: 0x0004_0000,
	UsageLimit: 0x0008_0000,
	StaleResponsesItem: 0x0010_0000,
	MalformedFunctionCall: 0x0020_0000,
	ProviderFinishError: 0x0040_0000,
	ContentBlocked: 0x0000_8000,
	ContextOverflow: 0x0080_0000,
	AuthFailed: 0x0100_0000,
	SilentAbort: 0x0200_0000,
	UserInterrupt: 0x0400_0000,
	Abort: 0x0800_0000,
	/** Strict-tool rejection (400): grammar too large, schema too complex, or structured outputs unsupported by the model/endpoint. */
	Grammar: 0x1000_0000,
	/** Anthropic model/account does not support fast mode / the `speed` parameter. */
	FastModeUnsupported: 0x2000_0000,
	/**
	 * The peer named a transport failure a replay reproduces: an HTTP/2 code from
	 * `NON_RETRYABLE_HTTP2_ERROR_CODES` (`NGHTTP2_CANCEL` — our own abort — `FLOW_CONTROL_ERROR`,
	 * `FRAME_SIZE_ERROR`, `COMPRESSION_ERROR`, `INADEQUATE_SECURITY`, `HTTP_1_1_REQUIRED`).
	 *
	 * It sits BESIDE the other flags rather than removing one. A wrapper is free to compose "connection
	 * error, please retry" around a cancel, and that sentence is still what the failure looks like, so
	 * `Flag.Transient` stays set and the message a caller renders is unchanged — a deadline that
	 * cancelled its own stream still says it timed out. What the code decides is whether anyone RETRIES
	 * it, which is recovery's job: the family that owns this flag vetoes a retry, and it is ordered
	 * ahead of `transport` so it answers first.
	 */
	TransportRefused: 0x4000_0000,
	// A dead OAuth grant has no flag. It used to have one — `OAuthExpiry`, in this table and in
	// KIND_MASK — that nothing ever set, so `is(id, Flag.OAuthExpiry)` answered false for every dead
	// grant there has ever been. The answer belongs to `isDefinitiveOAuthFailure` in
	// `domains/auth.ts`, which is a boolean because it decides whether to DISABLE a credential and
	// its two answers are not symmetric: a wrong yes destroys a working account, so anything
	// ambiguous resolves to no. A classification bit cannot carry that asymmetry, and classifying
	// the same prose here would turn a bare `400 invalid_grant` from a status into a flag set and
	// take the status away from callers that read it.
} as const;

export type Flag = (typeof Flag)[keyof typeof Flag];

/** Every bit that is a failure kind. `Class` is the marker bit and is not one. */
export const KIND_MASK: number = Object.entries(Flag)
	.filter(([name]) => name !== "Class")
	.reduce((bits, [, bit]) => bits | bit, 0);

/**
 * The label for each flag, derived from the flag's own name so a flag cannot exist without one.
 *
 * The hand-kept list this replaced stopped at thirteen entries while `Flag` grew to sixteen, so a
 * grammar rejection, a fast-mode wall and a dead OAuth grant each rendered in diagnostics as
 * `classified:0x10000000` — the three failures whose recovery is least obvious were the three with
 * no name. `Class` is the classified-marker bit rather than a kind, so it carries no label.
 */
export const ERROR_KIND_LABELS: readonly [Flag, string][] = Object.entries(Flag)
	.filter(([name]) => name !== "Class")
	.map(([name, bit]) => [bit, name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()] as [Flag, string]);

export function create(...flags: number[]): number {
	let bits = 0;
	for (const f of flags) bits |= f;
	return bits | Flag.Class;
}

export function is(id: number | undefined, flag: Flag): boolean {
	return ((id ?? 0) & flag) !== 0;
}

export function isClassified(id: number | undefined): boolean {
	return ((id ?? 0) & Flag.Class) !== 0;
}

export function statusFromId(id: number | undefined): number | undefined {
	return id && !isClassified(id) ? id : undefined;
}

export function stringify(id: number | undefined): string {
	if (!id) return "none";
	if (!isClassified(id)) return `status:${id}`;
	const labels = ERROR_KIND_LABELS.filter(([kind]) => is(id, kind)).map(([, label]) => label);
	return labels.length > 0 ? labels.join("|") : `classified:0x${id.toString(16)}`;
}
