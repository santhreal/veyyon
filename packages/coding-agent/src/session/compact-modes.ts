export type CompactMode = "summary";

export interface CompactionOverride {
	strategy?: CompactMode;
}

export interface CompactModeDef {
	readonly name: CompactMode;
	readonly description: string;
	readonly overrides: CompactionOverride;
}

export const COMPACT_MODES: readonly CompactModeDef[] = [
	{
		name: "summary",
		description: "Summarize history in place and keep working in the same session",
		overrides: { strategy: "summary" },
	},
];

export function findCompactMode(name: string): CompactModeDef | undefined {
	const key = name.trim().toLowerCase();
	return COMPACT_MODES.find(mode => mode.name === key);
}

const COMPACT_HANDOFF_ERROR =
	"`handoff` is not a compaction mode. Use `/handoff [focus instructions]` to transfer context to a new session.";

const RETIRED_COMPACT_MODES: Readonly<Record<string, string>> = {
	soft: "`soft` is no longer a compaction mode. It existed to SKIP server-side compaction for one invocation, and that is a setting now rather than a mode: turn off `compaction.remote` to always compact locally. Use `/compact summary`.",
	remote:
		"`remote` is no longer a compaction mode. Server-side compaction is not something you ask for per invocation: the `compaction.remote` setting governs it, and it runs on its own when the session model's provider supports it. Use `/compact summary`.",
};

export interface ParsedCompactArgs {
	mode?: CompactMode;
	instructions?: string;
	notice?: string;
}

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
		return { instructions: trimmed };
	}

	const focus = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();
	return { mode: mode.name, instructions: focus || undefined };
}
