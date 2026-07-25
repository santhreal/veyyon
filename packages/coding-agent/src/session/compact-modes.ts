/**
 * Manual `/compact` subcommands. Kept in a dependency-free leaf module so the
 * slash-command registry, the interactive controllers, and `AgentSession`
 * can all import the mode metadata + parser without pulling in the heavy
 * `agent-session` module graph (which would form an import cycle through the
 * slash-command registry) — same rationale as `shake-types.ts`.
 *
 * There are exactly two compaction strategies, and the modes are those two
 * strategies: `summary` condenses history in place, `handoff` writes a transfer
 * document and continues in a new session. A mode is a one-off override layered
 * on top of the configured `compaction.*` settings for a single invocation; it
 * never mutates settings.
 *
 * The former `soft` and `remote` modes are gone. Both existed only to steer the
 * provider-native remote compaction path (`soft` skipped it, `remote` demanded
 * it), which was removed because it handed the durable history to an opaque
 * provider-side blob and left a placeholder where the summary belonged. No
 * provider gets a private compaction path, so there is nothing left to steer.
 */

/** Subcommand selecting a one-off compaction strategy for manual `/compact`. */
export type CompactMode = "summary" | "handoff";

/**
 * Per-invocation overrides merged over the configured `compaction.*` settings.
 * Narrowed to the one knob the modes flip; the result stays assignable to the
 * full `CompactionSettings`.
 */
export interface CompactionOverride {
	strategy?: CompactMode;
}

export interface CompactModeDef {
	readonly name: CompactMode;
	/** One-line description surfaced in autocomplete + help. */
	readonly description: string;
	/** Settings overrides applied on top of `compaction.*` for this run. */
	readonly overrides: CompactionOverride;
}

export const COMPACT_MODES: readonly CompactModeDef[] = [
	{
		name: "summary",
		description: "Summarize history in place and keep working in the same session",
		overrides: { strategy: "summary" },
	},
	{
		name: "handoff",
		description: "Generate a handoff document and continue in a new session",
		overrides: { strategy: "handoff" },
	},
];

/** Resolve a subcommand token (case-insensitive) to its mode definition. */
export function findCompactMode(name: string): CompactModeDef | undefined {
	const key = name.trim().toLowerCase();
	return COMPACT_MODES.find(mode => mode.name === key);
}

/**
 * Mode names that used to exist, and what happens now that they do not.
 *
 * A name retired from `COMPACT_MODES` does not stop being typed: it is in muscle
 * memory, in notes, and in other people's scripts. Falling through to the
 * unknown-token path is the historically compatible thing to do, but on its own it
 * is silent — `/compact soft` would compact with the word "soft" folded into the
 * focus text and report success, so you would believe the mode you asked for ran.
 * Each retired name therefore carries the sentence the user gets told (Law 10: a
 * degraded path is allowed to be taken, never to be taken quietly).
 */
const RETIRED_COMPACT_MODES: Readonly<Record<string, string>> = {
	soft: "`soft` is no longer a compaction mode. It only existed to SKIP provider-native remote compaction, which veyyon no longer has, so in-place summarization is what runs now: use `/compact summary`.",
	remote:
		"`remote` is no longer a compaction mode. It asked the provider to compact its own way, which handed your durable history to an opaque provider-side blob; veyyon summarizes locally instead: use `/compact summary`.",
};

/** Parsed `/compact` arguments: an optional mode plus optional focus text. */
export interface ParsedCompactArgs {
	mode?: CompactMode;
	instructions?: string;
	/**
	 * Something the caller must show before compacting. Set when the leading token
	 * names a retired mode, so `/compact soft` cannot look like it selected one.
	 */
	notice?: string;
}

/**
 * Split `/compact` args into a leading mode subcommand + focus instructions.
 *
 * Backward compatible: when the first token is not a known mode, the entire
 * argument string is treated as focus instructions (the historical behavior).
 * That also keeps a stale `/compact soft ...` or `/compact remote ...` working
 * rather than erroring — the leading word is read as focus text and the
 * configured strategy runs. What it must not do is stay silent about it, so a
 * retired name comes back with a `notice`. The text is left exactly as typed
 * rather than stripped of the retired word, because `/compact soft dependency
 * bounds` may well be focus text that happens to start with "soft", and editing
 * a user's instruction to fit a guess is worse than telling them what ran.
 */
export function parseCompactArgs(args: string): ParsedCompactArgs | { error: string } {
	const trimmed = args.trim();
	if (!trimmed) return {};

	const spaceIndex = trimmed.search(/\s/);
	const firstToken = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
	const retired = RETIRED_COMPACT_MODES[firstToken.toLowerCase()];
	if (retired) {
		return { instructions: trimmed, notice: retired };
	}
	const mode = findCompactMode(firstToken);
	if (!mode) {
		// No recognized mode prefix — keep the whole thing as focus instructions.
		return { instructions: trimmed };
	}

	const focus = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();
	return { mode: mode.name, instructions: focus || undefined };
}
