/** Per-session guard against subagents looping on byte-identical no-op edits. A hashline patch can apply cleanly yet produce no change when the body rows */

interface NoopLoopEntry {
	/** Hash of the most recent input that no-op'd on this canonical path. */
	hash: string;
	/** Consecutive no-op count for the same `hash` on this path. */
	count: number;
}

/** Cross-session-safe state slot held on the `ToolSession`. */
export interface NoopLoopGuard {
	entries: Map<string, NoopLoopEntry>;
}

/** After this many consecutive byte-identical no-op edits on the same path, {@link recordNoopEdit} returns `escalate: true`. Picked deliberately small */
export const NOOP_HARD_LIMIT = 3;

interface NoopLoopGuardOwner {
	noopLoopGuard?: NoopLoopGuard;
}

/** Lazily create the per-session guard, mirroring `getFileSnapshotStore`. */
export function getNoopLoopGuard(session: NoopLoopGuardOwner): NoopLoopGuard {
	if (!session.noopLoopGuard) session.noopLoopGuard = { entries: new Map() };
	return session.noopLoopGuard;
}

/** Result of recording one no-op against the guard. */
export interface NoopRecordResult {
	/** Consecutive identical no-op count, including the current one. */
	count: number;
	/** True once `count >= NOOP_HARD_LIMIT` and the caller MUST escalate. */
	escalate: boolean;
}

/** Record a no-op edit for `canonicalPath` keyed by `inputHash` (a stable hash of the raw patch input bytes). Returns the running consecutive-no-op count */
export function recordNoopEdit(
	session: NoopLoopGuardOwner,
	canonicalPath: string,
	inputHash: string,
): NoopRecordResult {
	const guard = getNoopLoopGuard(session);
	const prev = guard.entries.get(canonicalPath);
	const count = prev && prev.hash === inputHash ? prev.count + 1 : 1;
	guard.entries.set(canonicalPath, { hash: inputHash, count });
	return { count, escalate: count >= NOOP_HARD_LIMIT };
}

/** Clear the no-op counter for `canonicalPath`. Call after a non-noop commit for the same path so a future no-op starts fresh from the soft hint. */
export function resetNoopEdit(session: NoopLoopGuardOwner, canonicalPath: string): void {
	const guard = session.noopLoopGuard;
	if (!guard) return;
	guard.entries.delete(canonicalPath);
}

/** Stable hash of the raw patch input. Bun's `Bun.hash` is xxHash64 — fast, non-cryptographic, more than adequate for "is this the same payload?". */
export function hashPatchInput(input: string): string {
	return Bun.hash(input).toString(16);
}
