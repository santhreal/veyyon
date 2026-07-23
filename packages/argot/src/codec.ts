import { DEFAULT_SIGIL, SUPPORTED_VERSION } from "./constants.js";
import type { AgentDict, HandleMeta, Vocabulary } from "./types.js";

/**
 * Raised when two vocabularies cannot be combined into one: they disagree on the
 * sigil, or they define the same handle name with different expansions. A
 * combined codec must expand every handle to exactly one string, so a genuine
 * disagreement fails loud at the moment of combination rather than resolving it
 * silently to one side (which would expand some occurrences to the wrong text).
 */
export class ArgotConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ArgotConflictError";
	}
}

/**
 * Combine several vocabularies into one, for a session that has loaded more than
 * one project's shorthand at once.
 *
 * The result is the union of every handle across the inputs. Combination is safe
 * because a handle name is content-addressed in the cache flow: two projects that
 * both learned the same string picked the same name for it, and different strings
 * get different names, so the sets slot together without collision. Two genuinely
 * conflicting definitions are the one thing that cannot be merged, so they throw
 * {@link ArgotConflictError}:
 *
 * - the same handle name bound to two different expansions, and
 * - two inputs declaring different sigils.
 *
 * A handle bound to the *same* expansion in two inputs is not a conflict; it is
 * deduplicated. Empty vocabularies contribute nothing and never fix the sigil, so
 * a union of empties is itself empty and keeps the default sigil.
 */
export function unionVocabularies(vocabs: Vocabulary[]): Vocabulary {
	const handles = new Map<string, string>();
	const meta = new Map<string, HandleMeta>();
	let sigil: string | undefined;

	for (const vocab of vocabs) {
		if (vocab.handles.size === 0) {
			continue;
		}
		if (sigil === undefined) {
			sigil = vocab.sigil;
		} else if (vocab.sigil !== sigil) {
			throw new ArgotConflictError(
				`cannot combine vocabularies with different sigils: "${sigil}" and "${vocab.sigil}"`,
			);
		}
		for (const [name, expansion] of vocab.handles) {
			const existing = handles.get(name);
			if (existing !== undefined && existing !== expansion) {
				throw new ArgotConflictError(
					`handle "${name}" is defined twice with different expansions: "${existing}" and "${expansion}"`,
				);
			}
			handles.set(name, expansion);
		}
		for (const [name, entry] of vocab.meta) {
			if (!meta.has(name)) {
				meta.set(name, entry);
			}
		}
	}

	return { version: SUPPORTED_VERSION, sigil: sigil ?? DEFAULT_SIGIL, handles, meta };
}

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
	const pattern = buildHandlePattern(vocab);
	if (pattern === undefined) {
		return text => text;
	}
	return text =>
		text.replace(pattern, (_match, name: string) => {
			// The alternation only matches known names, so this is always present.
			return vocab.handles.get(name) as string;
		});
}

/**
 * The `<sigil><name>(?![a-z0-9_])` matcher, longest name first so `§dbconn` wins
 * over `§db` and the boundary guard leaves `§dbextra` untouched. `undefined` when
 * the vocabulary has no handles. This is the ONE place the handle-matching rule
 * lives: {@link makeExpander} and {@link measureDecode} both build from it, so the
 * measurement of what a model adopted can never disagree with what actually
 * expanded.
 */
function buildHandlePattern(vocab: Vocabulary): RegExp | undefined {
	if (vocab.handles.size === 0) {
		return undefined;
	}
	// Longest name first: a greedy alternation would otherwise stop at the first
	// (shorter) branch that matches.
	const names = [...vocab.handles.keys()].sort((a, b) => b.length - a.length);
	const alternation = names.map(escapeRegExp).join("|");
	return new RegExp(`${escapeRegExp(vocab.sigil)}(${alternation})(?![a-z0-9_])`, "g");
}

/** One handle expansion the decoder performed, in original-text order. */
export interface DecodeReplacement {
	/** The handle name the model emitted (without the sigil). */
	name: string;
	/** The full text it expanded to. */
	expansion: string;
	/** The offset of the `<sigil><name>` match in the original text. */
	index: number;
}

/** What {@link measureDecode} observed while expanding a piece of model output. */
export interface DecodeMeasurement {
	/** The expanded text, byte-identical to {@link makeExpander}'s output for this vocabulary. */
	expanded: string;
	/** Every known-handle emission the model made, in order. `replacements.length` is adoption. */
	replacements: DecodeReplacement[];
	/**
	 * Sigil occurrences in the original text that did NOT form a known handle: a
	 * hallucinated name (`§nope`), or a real name with a trailing name character
	 * (`§dbextra`) the boundary guard refuses. These survive into {@link expanded}
	 * unchanged, so a non-zero count is a lossy leak of raw shorthand — exactly what
	 * an adoption bench must fail on.
	 */
	unknownSigilCount: number;
}

/**
 * Expand `text` for `vocab` AND report what happened: the expansion, every handle
 * the model actually used, and any sigil that did not resolve to a handle. Built
 * on the same matcher as {@link makeExpander} (see {@link buildHandlePattern}), so
 * `measureDecode(vocab, text).expanded === makeExpander(vocab)(text)` always holds.
 *
 * This is the measurement primitive an adoption benchmark stands on: adoption is
 * `replacements.length`, and losslessness is `unknownSigilCount === 0` with no raw
 * sigil surviving into `expanded`.
 */
export function measureDecode(vocab: Vocabulary, text: string): DecodeMeasurement {
	const pattern = buildHandlePattern(vocab);
	const replacements: DecodeReplacement[] = [];
	const expanded =
		pattern === undefined
			? text
			: text.replace(pattern, (_match, name: string, index: number) => {
					const expansion = vocab.handles.get(name) as string;
					replacements.push({ name, expansion, index });
					return expansion;
				});
	// Every non-overlapping sigil occurrence is either the start of a matched
	// handle or an unresolved sigil; matches never overlap and each consumes one
	// sigil, so unknown = total sigils − handles expanded.
	const totalSigils = vocab.sigil.length === 0 ? 0 : text.split(vocab.sigil).length - 1;
	const unknownSigilCount = Math.max(0, totalSigils - replacements.length);
	return { expanded, replacements, unknownSigilCount };
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
