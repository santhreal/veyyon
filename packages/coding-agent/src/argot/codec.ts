// Vendored from the standalone `argot` SDK. See ./constants.ts for the sync note.

import type { AgentDict, Vocabulary } from "./types";

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the expander for a vocabulary. It matches `<sigil><name>` where `name`
 * is a known handle, longest name first so `§dbconn` wins over `§db`, and only
 * where the match is not immediately followed by another handle-name character,
 * so `§dbextra` (no such handle) is left untouched rather than expanding `§db`.
 * Identity when the vocabulary has no handles.
 */
export function makeExpander(vocab: Vocabulary): (text: string) => string {
	if (vocab.handles.size === 0) {
		return text => text;
	}

	// Longest name first: a greedy alternation would otherwise stop at the first
	// (shorter) branch that matches.
	const names = [...vocab.handles.keys()].sort((a, b) => b.length - a.length);
	const alternation = names.map(escapeRegExp).join("|");
	const pattern = new RegExp(`${escapeRegExp(vocab.sigil)}(${alternation})(?![a-z0-9_])`, "g");

	return text =>
		text.replace(pattern, (_match, name: string) => {
			// The alternation only matches known names, so this is always present.
			return vocab.handles.get(name) as string;
		});
}

/**
 * Build the system-prompt block that teaches the model the handles. `""` when
 * the vocabulary is empty, so a harness can append it unconditionally.
 */
export function makePromptFragment(vocab: Vocabulary): string {
	if (vocab.handles.size === 0) {
		return "";
	}

	const lines: string[] = [];
	lines.push("## Project shorthand (Argot)");
	lines.push("");
	lines.push(
		`This project defines shorthand handles. When you would write one of the expansions below, write the handle instead: the marker \`${vocab.sigil}\` followed by the name. The harness restores the full text before anything runs or is shown, so handles are lossless. Only use a handle for its exact expansion; write everything else normally.`,
	);
	lines.push("");
	for (const [name, expansion] of vocab.handles) {
		lines.push(`- \`${vocab.sigil}${name}\` → \`${expansion}\``);
	}
	lines.push("");
	return lines.join("\n");
}

/** Assemble the public codec from a validated vocabulary. */
export function makeDict(vocab: Vocabulary): AgentDict {
	const expand = makeExpander(vocab);
	const fragment = makePromptFragment(vocab);
	return {
		promptFragment: () => fragment,
		expand,
	};
}

/** The inert codec: `promptFragment()` is `""` and `expand()` is identity. */
export function emptyDict(): AgentDict {
	return {
		promptFragment: () => "",
		expand: text => text,
	};
}
