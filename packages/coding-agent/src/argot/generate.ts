/**
 * Automatic `AGENTS.dict` generation.
 *
 * Point this at a corpus of the text a coding agent produces — its past
 * transcripts, a repository file listing, a set of build commands — and it
 * proposes the shorthand that would save the most output tokens, packed into a
 * dictionary that itself fits under a token budget (1000 by default). Use it two
 * ways: offline, to author a dictionary you review and keep, or at runtime, to
 * maintain a local per-project cache that regenerates as the repository moves.
 * The runtime case passes the current cache through {@link GenerateOptions.pinned}
 * so regeneration is monotonic: existing handles are frozen and only new ones are
 * added, which is what keeps already-written handles expandable over time.
 *
 * The economics it optimizes for: output tokens cost several times more than
 * input tokens, so a handle pays off when the model would otherwise retype a
 * long string many times. Each candidate is scored by how many output tokens it
 * removes across the corpus; the dictionary is filled highest-value first until
 * the next entry would breach the budget. The budget is on the *dictionary*
 * because the dictionary is what a harness reads into context (see load-on-read
 * in the README); a huge dictionary would cost more to carry than it saves.
 *
 * Everything is a pure function of the corpus and the options, and the token
 * counter is injectable, so you can drive it with a real tokenizer for your
 * model or accept the built-in heuristic. The emitted TOML always re-parses
 * through `parseDict` to an identical vocabulary — generation never produces a
 * dictionary the loader would reject.
 */

import { DEFAULT_SIGIL, HANDLE_NAME_RE, MAX_EXPANSION_BYTES } from "./constants";
import type { Vocabulary } from "./types";

const utf8 = new TextEncoder();

/** How to name generated handles. */
export type HandleNaming =
	/** Short mnemonics derived from each expansion (readable in a diff). The default. */
	| "mnemonic"
	/** Sequential numbers (`§1`, `§2`, …): the densest handles, least self-documenting. */
	| "numeric"
	/**
	 * A readable stem plus a hash of the expansion. The name is a pure function of
	 * the expansion alone, with no dependence on ordering or a shared counter, so
	 * two processes generating over the same project independently pick the SAME
	 * name for the same string and different names for different strings. Use this
	 * when several agents may regenerate one shared cache concurrently: it removes
	 * the write-coordination a mnemonic or numeric scheme would need.
	 */
	| "content";

/** Options for {@link generateDict}. Every field has a sensible default. */
export interface GenerateOptions {
	/** Token budget for the generated dictionary itself. Default `1000`. */
	tokenBudget?: number;
	/** Sigil for the emitted file. Default {@link DEFAULT_SIGIL}. */
	sigil?: string;
	/** Least number of corpus occurrences a string needs to be considered. Default `2`. */
	minFrequency?: number;
	/** Least expansion length in characters. Short strings rarely pay for a handle. Default `8`. */
	minExpansionLength?: number;
	/** Optional hard cap on how many handles to emit, applied after the budget. */
	maxHandles?: number;
	/** How to name handles. Default `"mnemonic"`. */
	naming?: HandleNaming;
	/**
	 * Token counter. Defaults to {@link estimateTokens}, a tokenizer-agnostic
	 * heuristic. Pass your model's real tokenizer for exact accounting.
	 */
	countTokens?: (text: string) => number;
	/**
	 * Candidate extractor: given one corpus sample, yield the strings worth
	 * considering. Defaults to {@link extractCandidates}.
	 */
	extract?: (text: string) => Iterable<string>;
	/**
	 * Existing bindings to preserve, for MONOTONIC regeneration. Pass the current
	 * cached vocabulary here and generation keeps every pinned name→expansion
	 * verbatim: no pinned name is ever reassigned to a different expansion, no
	 * pinned expansion is proposed a second time under a new name, and no new
	 * handle takes a pinned name. New handles are added under the remaining
	 * budget, but pinned entries are retained even when they alone exceed it — a
	 * handle already taught to the model must never disappear, or text that used
	 * it stops expanding. This is what makes the generated dictionary safe to
	 * treat as a regenerating local cache. When `pinned` carries handles its
	 * sigil is authoritative and any `sigil` option is ignored.
	 */
	pinned?: Vocabulary;
}

/** One handle chosen by {@link generateDict}, with the accounting behind it. */
export interface GeneratedHandle {
	/** The handle name (without the sigil), matching `[a-z0-9_]+`. */
	name: string;
	/** The full string the handle stands for. */
	expansion: string;
	/** How many times the expansion occurred in the corpus. */
	frequency: number;
	/** Estimated output tokens saved across the corpus by using this handle. */
	savedTokens: number;
	/** Estimated tokens this entry costs in the dictionary. */
	dictTokens: number;
}

/** The result of {@link generateDict}. */
export interface GeneratedDict {
	/**
	 * The selected vocabulary. Its `handles` map is empty when nothing in the
	 * corpus was worth encoding; in that case {@link GeneratedDict.toml} is `""`.
	 */
	vocab: Vocabulary;
	/**
	 * The `AGENTS.dict` file text, ready to write. Always re-parses through
	 * `parseDict` to `vocab`. `""` when no handles were selected (an empty
	 * `[handles]` table is not a valid dictionary).
	 */
	toml: string;
	/** The chosen handles, highest value first. */
	handles: GeneratedHandle[];
	/**
	 * Total estimated dictionary token cost. Never exceeds
	 * {@link GenerateOptions.tokenBudget} for the newly added handles; when
	 * {@link GenerateOptions.pinned} bindings are retained they are always kept
	 * even if the frozen base alone is already over budget.
	 */
	dictTokens: number;
	/** Total estimated output tokens saved per full pass over the corpus. */
	estimatedSavings: number;
	/** The token budget the generation ran under. */
	tokenBudget: number;
	/** How many distinct candidates were considered before selection. */
	candidatesConsidered: number;
}

/**
 * A tokenizer-agnostic token estimate. Approximates a byte-pair tokenizer well
 * enough to rank candidates: each alphanumeric run counts as roughly one token
 * per four characters, and each standalone symbol (a slash, dot, colon, dash)
 * counts as its own token, which is why a path costs more than its letter count
 * suggests. Inject a real tokenizer through {@link GenerateOptions.countTokens}
 * when you need exact figures.
 */
export function estimateTokens(text: string): number {
	if (text.length === 0) {
		return 0;
	}
	let tokens = 0;
	const words = text.match(/[A-Za-z0-9]+/g) ?? [];
	for (const word of words) {
		tokens += Math.max(1, Math.ceil(word.length / 4));
	}
	// Every non-alphanumeric, non-whitespace character tends to be its own token.
	const symbols = text.replace(/[A-Za-z0-9\s]/g, "").length;
	tokens += symbols;
	return Math.max(1, tokens);
}

/** Trim wrapping punctuation a candidate is likely surrounded by in prose or code. */
function trimWrapping(token: string): string {
	return token.replace(/^[["'`(<{]+/, "").replace(/[\]"'`)>},;]+$/, "");
}

/** True when a token looks like a path, command, URL, or dotted identifier rather than prose. */
function isStructured(token: string): boolean {
	// A slash, backslash, a dot between word characters, a scoped `::`, or a
	// URL-ish `:` all mark a token as structured. A bare hyphenated word does not.
	return /[/\\]/.test(token) || /\w\.\w/.test(token) || /::/.test(token) || /:\/\//.test(token);
}

/**
 * True when a whole line reads like a command rather than a prose sentence: it
 * references something structured (a path, URL, dotted identifier), passes a
 * flag (`-x` / `--x`), or sets an assignment (`KEY=value`). A natural-language
 * sentence has none of these, so it is not captured.
 */
function looksLikeCommand(tokens: string[]): boolean {
	return tokens.some(t => isStructured(t) || /^-{1,2}\w/.test(t) || /^\w[\w-]*=/.test(t));
}

/**
 * The default candidate extractor. Pulls two kinds of recurring string out of a
 * corpus sample:
 *
 *   - **structured tokens** — whitespace-delimited runs that look like a path,
 *     filename, URL, or dotted/scoped identifier (they contain a separator, not
 *     just letters), and
 *   - **command-like lines** — a whole trimmed line that contains a space, so a
 *     multi-word build or deploy command is captured intact.
 *
 * Anything containing the sigil is skipped, since it could never be an
 * expansion. Ordering is preserved so generation is deterministic.
 */
export function extractCandidates(text: string): string[] {
	const out: string[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.length === 0) {
			continue;
		}
		const rawTokens = line.split(/\s+/);
		// A whole command-like line: multiple words that reference something
		// structured, worth encoding as one unit. Prose sentences are excluded.
		if (/\s/.test(line) && !/^[#*]/.test(line) && looksLikeCommand(rawTokens)) {
			out.push(line);
		}
		for (const rawToken of rawTokens) {
			const token = trimWrapping(rawToken);
			if (token.length > 0 && isStructured(token)) {
				out.push(token);
			}
		}
	}
	return out;
}

/** A short readable stem from an expansion's last path segment, for handle names. */
function nameStem(expansion: string): string {
	const segment = expansion.split(/[/\\]/).filter(Boolean).pop() ?? expansion;
	let base = segment
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "")
		.slice(0, 6);
	if (base.length === 0) {
		base = expansion
			.toLowerCase()
			.replace(/[^a-z0-9_]+/g, "")
			.slice(0, 6);
	}
	return base.length === 0 ? "h" : base;
}

/** A 32-bit FNV-1a hash of a string, seedable so two rounds give an independent value. */
function fnv1a(text: string, seed: number): number {
	let hash = seed >>> 0;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

/**
 * A content-addressed handle name: a readable stem plus a hash of the whole
 * expansion. Deterministic in the expansion alone, so it needs no shared counter
 * or `taken` set to stay collision-free across independent generators. Two hash
 * rounds widen the space enough that a collision between distinct expansions is
 * negligible for realistic dictionary sizes.
 */
function contentName(expansion: string): string {
	const hash = fnv1a(expansion, 0x811c9dc5).toString(36) + fnv1a(expansion, 0x9e3779b1).toString(36);
	return `${nameStem(expansion)}_${hash.slice(0, 8)}`;
}

/** Build a short, valid, unique handle name for an expansion, avoiding `taken`. */
function mnemonicName(expansion: string, taken: Set<string>): string {
	const base = nameStem(expansion);
	if (!taken.has(base)) {
		return base;
	}
	for (let n = 2; ; n++) {
		const candidate = `${base}${n}`;
		if (!taken.has(candidate)) {
			return candidate;
		}
	}
}

/** Escape a string for a TOML basic (double-quoted) string. */
function escapeTomlBasic(value: string): string {
	let out = "";
	for (const ch of value) {
		const code = ch.codePointAt(0) ?? 0;
		if (ch === "\\") {
			out += "\\\\";
		} else if (ch === '"') {
			out += '\\"';
		} else if (ch === "\n") {
			out += "\\n";
		} else if (ch === "\t") {
			out += "\\t";
		} else if (ch === "\r") {
			out += "\\r";
		} else if (code < 0x20) {
			out += `\\u${code.toString(16).padStart(4, "0")}`;
		} else {
			out += ch;
		}
	}
	return out;
}

/** Serialize a chosen vocabulary to `AGENTS.dict` TOML text. */
function toToml(sigil: string, handles: GeneratedHandle[]): string {
	const lines: string[] = [];
	lines.push("# Generated by argot. Review before committing: a handle must stand");
	lines.push("# for exactly the string it replaces. Edit freely; this is just a start.");
	lines.push("version = 1");
	if (sigil !== DEFAULT_SIGIL) {
		lines.push(`sigil = "${escapeTomlBasic(sigil)}"`);
	}
	lines.push("");
	lines.push("[handles]");
	for (const handle of handles) {
		lines.push(`${handle.name} = "${escapeTomlBasic(handle.expansion)}"`);
	}
	lines.push("");
	return lines.join("\n");
}

interface Candidate {
	expansion: string;
	frequency: number;
	firstSeen: number;
}

/** One repository file for {@link generateDictFromRepo}. */
export interface RepoFile {
	/**
	 * The repo-relative path, e.g. a line from `git ls-files`. Always enters as a
	 * candidate, so a path the agent will type is proposed even if no other file
	 * mentions it.
	 */
	path: string;
	/**
	 * The file's text, if you have it. Scanned for the structured tokens and
	 * command lines that recur across the repo, so a widely-referenced path or a
	 * repeated command gains frequency (its centrality). Omit it to rank on the
	 * listing alone (longest paths first).
	 */
	content?: string;
}

/**
 * Generate an `AGENTS.dict` from a corpus.
 *
 * `corpus` is the text to learn from: pass one string or many. Returns the
 * chosen handles, the ready-to-write TOML, and the token accounting. When
 * nothing clears the thresholds the result is empty (`toml === ""`,
 * `handles.length === 0`) rather than an error — an empty corpus simply has no
 * shorthand to propose.
 */
export function generateDict(corpus: string | string[], options: GenerateOptions = {}): GeneratedDict {
	const tokenBudget = options.tokenBudget ?? 1000;
	// When regenerating monotonically, the pinned vocabulary's sigil is
	// authoritative: the cache was written with it and every frozen handle keys on
	// it, so an option that disagreed would split the marker.
	const pinnedEntries: Array<[string, string]> = options.pinned ? [...options.pinned.handles] : [];
	const hasPinned = pinnedEntries.length > 0;
	const sigil = hasPinned && options.pinned ? options.pinned.sigil : (options.sigil ?? DEFAULT_SIGIL);
	const pinnedNames = new Set<string>();
	const pinnedExpansions = new Set<string>();
	for (const [name, expansion] of pinnedEntries) {
		pinnedNames.add(name);
		pinnedExpansions.add(expansion);
	}
	const minFrequency = options.minFrequency ?? 2;
	const minExpansionLength = options.minExpansionLength ?? 8;
	const naming = options.naming ?? "mnemonic";
	const countTokens = options.countTokens ?? estimateTokens;
	const extract = options.extract ?? extractCandidates;
	const samples = typeof corpus === "string" ? [corpus] : corpus;

	// Count distinct candidate expansions, preserving first-seen order so the
	// result is deterministic when scores tie.
	const seen = new Map<string, Candidate>();
	let ordinal = 0;
	for (const sample of samples) {
		for (const rawExpansion of extract(sample)) {
			const expansion = rawExpansion;
			if (expansion.length < minExpansionLength) {
				continue;
			}
			if (expansion.includes(sigil)) {
				continue; // an expansion may never contain the sigil
			}
			if (utf8.encode(expansion).length > MAX_EXPANSION_BYTES) {
				continue;
			}
			const existing = seen.get(expansion);
			if (existing) {
				existing.frequency += 1;
			} else {
				seen.set(expansion, { expansion, frequency: 1, firstSeen: ordinal++ });
			}
		}
	}

	const candidatesConsidered = seen.size;

	// Score each candidate by the output tokens it would remove. The handle's own
	// token cost depends on its length; a numeric handle is a couple of tokens, a
	// mnemonic a few, so score against the naming scheme's typical handle.
	const scored: Array<{ candidate: Candidate; savedTokens: number; handleTokens: number }> = [];
	let numericProbe = 0;
	for (const candidate of seen.values()) {
		if (candidate.frequency < minFrequency) {
			continue;
		}
		if (pinnedExpansions.has(candidate.expansion)) {
			continue; // already has a frozen handle; never propose a second one
		}
		// Approximate the handle length for scoring; exact names are assigned later.
		// Content naming produces a longer name, so score it against its real name.
		const probeName =
			naming === "numeric"
				? String(++numericProbe)
				: naming === "content"
					? contentName(candidate.expansion)
					: "abcd";
		const handleTokens = countTokens(sigil + probeName);
		const expansionTokens = countTokens(candidate.expansion);
		const perUse = expansionTokens - handleTokens;
		if (perUse <= 0) {
			continue; // the handle is not shorter than what it replaces
		}
		scored.push({ candidate, savedTokens: perUse * candidate.frequency, handleTokens });
	}

	// Highest savings first; tie-break by density, then stable by first-seen so
	// generation is deterministic.
	scored.sort((a, b) => {
		if (b.savedTokens !== a.savedTokens) {
			return b.savedTokens - a.savedTokens;
		}
		const densityA = a.savedTokens / Math.max(1, countTokens(a.candidate.expansion));
		const densityB = b.savedTokens / Math.max(1, countTokens(b.candidate.expansion));
		if (densityB !== densityA) {
			return densityB - densityA;
		}
		return a.candidate.firstSeen - b.candidate.firstSeen;
	});

	// Fill the dictionary highest value first, stopping before the budget breaks.
	const headerTokens = countTokens(
		sigil !== DEFAULT_SIGIL ? `version = 1\nsigil = "${sigil}"\n\n[handles]\n` : "version = 1\n\n[handles]\n",
	);
	// New handle names must avoid every pinned name (monotonic: a pinned name is
	// frozen to its expansion and can never be reused for something else).
	const taken = new Set<string>(pinnedNames);
	let dictTokens = headerTokens;

	// Frozen base: retain every pinned binding verbatim, scored by its frequency in
	// the current corpus (0 if the string no longer appears). Always counted toward
	// dictTokens, even past the budget — dropping a taught handle would break any
	// text that already used it.
	const pinnedHandles: GeneratedHandle[] = [];
	for (const [name, expansion] of pinnedEntries) {
		const frequency = seen.get(expansion)?.frequency ?? 0;
		const perUse = countTokens(expansion) - countTokens(sigil + name);
		const entryTokens = countTokens(`${name} = "${expansion}"`);
		dictTokens += entryTokens;
		pinnedHandles.push({
			name,
			expansion,
			frequency,
			savedTokens: Math.max(0, perUse) * frequency,
			dictTokens: entryTokens,
		});
	}

	// Continue numeric naming past the largest pinned number so a new handle never
	// collides with a frozen one.
	let numeric = 0;
	if (naming === "numeric") {
		for (const name of pinnedNames) {
			const n = Number(name);
			if (Number.isInteger(n) && n > numeric) {
				numeric = n;
			}
		}
	}

	// New handles fill the remaining budget. maxHandles caps the TOTAL, and pinned
	// entries are never dropped to satisfy it, so new additions get whatever room
	// is left under the cap.
	const chosenNew: GeneratedHandle[] = [];
	for (const entry of scored) {
		if (options.maxHandles !== undefined && pinnedHandles.length + chosenNew.length >= options.maxHandles) {
			break;
		}
		const name =
			naming === "numeric"
				? String(++numeric)
				: naming === "content"
					? contentName(entry.candidate.expansion)
					: mnemonicName(entry.candidate.expansion, taken);
		// Names are generated, so they always match the handle grammar; assert it
		// to fail loud rather than emit a dict the loader would reject.
		if (!HANDLE_NAME_RE.test(name)) {
			continue;
		}
		// A content name is a hash, so on the rare chance two distinct expansions
		// collide, skip the second rather than overwrite the first: losing a handle
		// costs a little compression, reusing a name would mis-expand.
		if (taken.has(name)) {
			continue;
		}
		const entryTokens = countTokens(`${name} = "${entry.candidate.expansion}"`);
		if (dictTokens + entryTokens > tokenBudget) {
			continue; // does not fit; a smaller later entry still might
		}
		taken.add(name);
		dictTokens += entryTokens;
		chosenNew.push({
			name,
			expansion: entry.candidate.expansion,
			frequency: entry.candidate.frequency,
			savedTokens: entry.savedTokens,
			dictTokens: entryTokens,
		});
	}

	// Present pinned and new together, highest savings first. Order is cosmetic
	// (the loader keys on names, not position); a deterministic sort keeps
	// regeneration stable. Tie-break by name so the result is fully determined.
	const chosen: GeneratedHandle[] = [...pinnedHandles, ...chosenNew].sort((a, b) => {
		if (b.savedTokens !== a.savedTokens) {
			return b.savedTokens - a.savedTokens;
		}
		return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
	});

	const handleMap = new Map<string, string>();
	for (const handle of chosen) {
		handleMap.set(handle.name, handle.expansion);
	}
	const vocab: Vocabulary = { version: 1, sigil, handles: handleMap, meta: new Map() };
	const toml = chosen.length > 0 ? toToml(sigil, chosen) : "";
	const estimatedSavings = chosen.reduce((sum, h) => sum + h.savedTokens, 0);

	return {
		vocab,
		toml,
		handles: chosen,
		dictTokens: chosen.length > 0 ? dictTokens : 0,
		estimatedSavings,
		tokenBudget,
		candidatesConsidered,
	};
}

/**
 * Generate an `AGENTS.dict` from a repository — the recommended starting point.
 *
 * Pass the repo's files (a `git ls-files` listing, optionally with contents).
 * Every path becomes a candidate, because a path in the tree is a string the
 * agent will type whether or not another file mentions it; when contents are
 * given, the strings that recur across them gain frequency, so a widely
 * referenced path or a repeated command ranks above a one-off. The result is
 * still packed under the token budget, highest value first.
 *
 * Because the listing guarantees each path is seen at least once, this defaults
 * `minFrequency` to `1` (unlike {@link generateDict}, which defaults to `2` for a
 * free-text corpus). Override any option as usual; your value wins.
 */
export function generateDictFromRepo(files: RepoFile[], options: GenerateOptions = {}): GeneratedDict {
	const samples: string[] = [];
	// Each path on its own line so it is enumerated as a candidate token.
	for (const file of files) {
		samples.push(file.path);
	}
	// Contents contribute frequency: a path referenced across many files, or a
	// command repeated in scripts, is counted every time it appears.
	for (const file of files) {
		if (file.content !== undefined) {
			samples.push(file.content);
		}
	}
	return generateDict(samples, { minFrequency: 1, ...options });
}
