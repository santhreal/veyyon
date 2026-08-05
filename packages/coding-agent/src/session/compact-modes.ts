/**
 * Manual `/compact` argument parsing. Kept in a dependency-free leaf module so
 * the slash-command registry, interactive controllers, and `AgentSession` can
 * share the canonical mode metadata without importing the heavy session graph.
 *
 * Compaction has one behavior: `summary` condenses persisted history in place
 * and continues the same session. Handoff is an explicit session-transfer
 * operation exposed by `/handoff`; it is never a `/compact` mode.
 */

/** The sole explicit mode accepted by manual `/compact`. */
export type CompactMode = "summary";

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
const COMPACT_HANDOFF_ERROR =
	"`handoff` is not a compaction mode. Use `/handoff [focus instructions]` to transfer context to a new session.";

const RETIRED_COMPACT_MODES: Readonly<Record<string, string>> = {
	soft: "`soft` is no longer a compaction mode. It only existed to SKIP provider-native remote compaction, which veyyon no longer has, so in-place summarization is what runs now: use `/compact summary`.",
	remote:
		"`remote` is no longer a compaction mode. It asked the provider to compact its own way, which handed your durable history to an opaque provider-side blob; veyyon summarizes locally instead: use `/compact summary`.",
};

/** Parsed `/compact` arguments: the optional canonical mode plus optional focus text. */
export interface ParsedCompactArgs {
	mode?: CompactMode;
	instructions?: string;
	/** Something the caller must show before compacting for a retired non-handoff mode. */
	notice?: string;
}

/**
 * Split `/compact` args into an optional `summary` token plus focus instructions.
 *
 * Unknown leading tokens remain focus text for backward compatibility. A leading
 * `handoff` is the exception: accepting it as focus would silently run a summary
 * when the operator asked for session transfer, so it fails with the explicit
 * command that performs that operation.
 */
export function parseCompactArgs(args: string): ParsedCompactArgs | { error: string } {
	const trimmed = args.trim();
	if (!trimmed) return {};

	const spaceIndex = trimmed.search(/\s/);
	const firstToken = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
	if (firstToken.toLowerCase() === "handoff") return { error: COMPACT_HANDOFF_ERROR };
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
