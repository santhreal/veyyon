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
 * The value a handle removes is proxied by DOCUMENT frequency, not raw term
 * frequency. What a model re-emits is a string that is *central* to the project:
 * a path, command, or identifier that shows up across many files. A string that
 * occurs thousands of times inside one file and nowhere else — a lockfile's
 * registry lines, an inlined SVG, a license header — is not something a model
 * types back, so its raw count must not win the budget. Scoring therefore counts
 * how many distinct corpus samples (files) a string appears in and damps
 * repetition *within* one sample, so no single file can dominate the ranking.
 * See {@link scoringFrequency}.
 *
 * Everything is a pure function of the corpus and the options, and the token
 * counter is injectable, so you can drive it with a real tokenizer for your
 * model or accept the built-in heuristic. The emitted TOML always re-parses
 * through `parseDict` to an identical vocabulary — generation never produces a
 * dictionary the loader would reject.
 */

import { DEFAULT_SIGIL, DEFAULT_TOKEN_BUDGET, HANDLE_NAME_RE, MAX_EXPANSION_BYTES } from "./constants.js";
import type { Vocabulary } from "./types.js";

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
	/** Token budget for the generated dictionary itself. Default {@link DEFAULT_TOKEN_BUDGET}. */
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
	/** How many times the expansion occurred in the corpus (raw occurrence count). */
	frequency: number;
	/**
	 * In how many distinct corpus samples (files) the expansion occurred: its
	 * centrality. This is the signal scoring is based on, not {@link frequency};
	 * see {@link scoringFrequency}. Always `<= frequency`.
	 */
	documentFrequency: number;
	/** Estimated output tokens saved across the corpus by using this handle. */
	savedTokens: number;
	/** Estimated tokens this entry costs in the dictionary. */
	dictTokens: number;
}

/**
 * The frequency scoring multiplies by: document frequency plus a damped bonus for
 * repetition within a single sample.
 *
 * `documentFrequency` is how many distinct samples (files, transcript turns)
 * contain the string — its breadth, the best proxy for how often a model will
 * re-emit it. The extra term, `floor(log2(1 + within))` where `within` is the
 * occurrences beyond one-per-sample, credits a string that genuinely repeats
 * inside representative files but damps it hard: a lockfile line repeated 4000
 * times in one file contributes `floor(log2(4000)) = 11` on top of its document
 * frequency of 1, so it can never outweigh a path that appears once across a
 * dozen files. This is the one home for the rule; scoring and the bench both call
 * it so there is a single definition of "how valuable is this string".
 *
 * Degenerates cleanly: for a single-sample corpus every string has
 * `documentFrequency` 1 and the result is `1 + floor(log2(rawFrequency))`, a
 * log-damped term frequency; for one-occurrence-per-sample corpora `within` is 0
 * and the result is exactly the document frequency.
 */
export function scoringFrequency(rawFrequency: number, documentFrequency: number): number {
	const within = Math.max(0, rawFrequency - documentFrequency);
	return documentFrequency + Math.floor(Math.log2(1 + within));
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

/**
 * Code-expression punctuation. A genuinely re-typed token — a path, filename,
 * import specifier, URL, or dotted/scoped identifier — is built only from word
 * characters and path glue (`/ \ . : @ ~ - _ + #`). The moment a candidate
 * contains a paren, bracket, brace, backtick, dollar, quote, comma, semicolon,
 * or a comparison/logic operator, it is a fragment of a live code expression
 * (`${theme.fg('dim`, `parts.push(theme.fg('dim`, `line.trim().match(/^(.*)/`),
 * not a stable string an agent retypes. Those fragments are the dominant source
 * of dictionary noise in a code corpus, so any token bearing one is rejected.
 */
const CODE_PUNCTUATION = /[(){}[\]`'"$;,=<>!?*|&]/;

/**
 * True when a token is worth encoding as a handle. A string a coding agent
 * literally retypes — and that is long enough to be worth a handle — is a path, an
 * import specifier, a URL, or a scoped (`::`) module path. Every one of those
 * carries a real separator: a slash/backslash, or a `::`. So the token must both
 * carry such a separator AND be free of {@link CODE_PUNCTUATION}.
 *
 * Note what this deliberately drops: a bare dotted identifier (`theme.fg`,
 * `state.results.length`). Those satisfy {@link isStructured}'s `\w\.\w` rule but
 * are property access, not stable strings — an agent never types `§h` in place of
 * `theme.fg`. A genuine repository filename (`connection.ts`) is not lost by this:
 * {@link generateDictFromRepo} feeds every real path in the tree as a candidate
 * directly, so bare filenames enter the dictionary through the file listing rather
 * than through content-token extraction. Command lines that legitimately contain
 * `=`/`&&` are captured by the separate whole-line branch, not here.
 */
function isReusableToken(token: string): boolean {
	if (CODE_PUNCTUATION.test(token)) {
		return false;
	}
	return /[/\\]/.test(token) || /::/.test(token);
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
 * True when a line is a SOURCE-CODE statement, not a re-emittable command. This is
 * the disqualifier for whole-line capture: `looksLikeCommand` fires on almost every
 * line of a code file, because a method call or property access (`gem.homepage_uri`,
 * `theme.fg(...)`) satisfies {@link isStructured}. A model never retypes an arbitrary
 * full statement verbatim, so capturing whole code lines as handles fills the
 * dictionary with noise no model adopts and wastes the budget on the longest lines.
 *
 * A genuine agent-typed command — `bunx tsgo -p x/tsconfig.json --noEmit`,
 * `npm run build && node dist/index.js`, `CARGO_TARGET_DIR=/dev/null cargo test` —
 * carries none of the code punctuation this matches: a statement terminator (`;`),
 * a block/object brace (`{`/`}`), a template literal (`` ` ``), an arrow (`=>`), or
 * call syntax (an identifier immediately followed by `(`, like `Buffer.from(`). Any
 * one of these marks the line as code, so it is ranked on its structured *tokens*
 * (paths, import specifiers, dotted identifiers) instead of captured whole.
 */
function looksLikeSourceCode(line: string): boolean {
	if (/[;`{}]/.test(line) || /=>/.test(line) || /\w\(/.test(line)) {
		return true;
	}
	// A parenthesized opener is an expression fragment, not a command
	// (`(parsedDiagnostics.length > 0 ? a : b`).
	if (/^\(/.test(line)) {
		return true;
	}
	// JavaScript-only operators that never appear in a shell command line: optional
	// chaining, nullish coalescing, and strict (in)equality. `&&`/`||` are excluded
	// on purpose — they are valid shell (`cargo test --all && echo done`).
	if (/\?\.|\?\?|!==|===/.test(line)) {
		return true;
	}
	// A line ENDING on a dangling binary/continuation operator is a wrapped
	// expression, not a command (`state.results.length > 0 ||`, `runtime.mode ??`).
	// A real command ends on its last argument, never a bare operator.
	if (/(\|\||&&|\?\?|[,+*=<>?:])$/.test(line)) {
		return true;
	}
	// A line that OPENS with a language keyword is a statement, not a command — even
	// when it carries no punctuation on this physical line (`if (a !== b || c`,
	// `return process.platform`, `const header = state.metrics`). Commands never
	// start with one of these words.
	const firstWord = (line.split(/\s+/, 1)[0] ?? "").replace(/[^A-Za-z]/g, "");
	return SOURCE_KEYWORDS.has(firstWord);
}

/**
 * JavaScript/TypeScript statement openers. A line beginning with one of these is
 * source code, never a shell command, so it is never captured as a whole handle.
 * This is a language-heuristic constant, not extensible domain data.
 */
const SOURCE_KEYWORDS = new Set([
	"if",
	"else",
	"for",
	"while",
	"switch",
	"case",
	"default",
	"const",
	"let",
	"var",
	"return",
	"function",
	"class",
	"type",
	"interface",
	"import",
	"export",
	"await",
	"async",
	"new",
	"throw",
	"try",
	"catch",
	"finally",
	"do",
	"break",
	"continue",
	"enum",
	"namespace",
	"declare",
	"public",
	"private",
	"protected",
	"static",
	"yield",
	"extends",
	"implements",
	"super",
	"this",
]);

/** True when a line opens with a comment marker (line/block/doc comment, markdown heading or bullet). */
function isCommentLine(line: string): boolean {
	return /^(#|\/\/|\/\*|\*|<!--|--)/.test(line);
}

/**
 * The default candidate extractor. Pulls two kinds of recurring string out of a
 * corpus sample:
 *
 *   - **structured tokens** — whitespace-delimited runs that look like a path,
 *     filename, URL, or dotted/scoped identifier (they contain a separator, not
 *     just letters) AND carry no {@link CODE_PUNCTUATION}. The cleanliness gate
 *     (see {@link isReusableToken}) is essential on a code corpus: without it, an
 *     expression fragment such as `${theme.fg('dim` or `parts.push(theme.fg('dim`
 *     satisfies the `\w\.\w` rule and floods the dictionary with strings no agent
 *     ever retypes. Only clean tokens (`packages/app/src/db.ts`, `@scope/pkg`,
 *     `https://host/path`) survive, and
 *   - **command-like lines** — a whole trimmed line that contains a space and reads
 *     like a build/deploy command, captured intact. Source-code statements are
 *     NOT captured, even though they look "structured": a model never retypes an
 *     arbitrary full line of code, so a whole code line is dictionary noise. See
 *     {@link looksLikeSourceCode}. The structured *tokens* inside a code line (its
 *     paths, import specifiers, dotted identifiers) are still extracted below.
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
		// structured, worth encoding as one unit. Prose sentences are excluded, and
		// so are source-code statements — a model never retypes an arbitrary full line
		// of code, so capturing one only wastes budget (see looksLikeSourceCode).
		if (/\s/.test(line) && !isCommentLine(line) && looksLikeCommand(rawTokens) && !looksLikeSourceCode(line)) {
			out.push(line);
		}
		for (const rawToken of rawTokens) {
			const token = trimWrapping(rawToken);
			if (token.length > 0 && isReusableToken(token)) {
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

/**
 * Assign a short, deterministic handle name to every expansion in a set.
 *
 * Two goals the runtime cache needs at once:
 *
 *  - BREVITY. The token win only exists when a handle is shorter than the string
 *    it replaces. An expansion whose stem is unique among the set gets the bare
 *    stem (`conn` for `.../connection-pool`) — the shortest possible name. Only
 *    expansions that COLLIDE on a stem pay a disambiguator, and only the shortest
 *    hash prefix that separates them, grown one character at a time. This is why
 *    the cache no longer uses the content scheme's fixed 8-char hash on every
 *    handle, which made handles nearly as long as short expansions.
 *
 *  - DETERMINISM. A name is a pure function of the expansion plus the set of
 *    other expansions that share its stem, never of iteration order: expansions
 *    are grouped by stem, groups and their members are processed in sorted order,
 *    and disambiguators come from a hash of the expansion. So two independent
 *    generators over the same expansion set mint byte-identical names, which is
 *    exactly what lets the immutable content-signature cache adopt short names
 *    with no cross-generator coordination (the property the content scheme had).
 *
 * `reserved` holds names already bound to a frozen (pinned) handle; a new name is
 * never allowed to equal one, so a pin's expansion can never be silently reused.
 */
function buildMnemonicNames(allExpansions: Iterable<string>, reserved: Iterable<string> = []): Map<string, string> {
	// Group distinct expansions by stem. Dedupe defensively; the caller passes
	// distinct candidates, but a duplicate would otherwise inflate a group.
	const byStem = new Map<string, Set<string>>();
	for (const expansion of allExpansions) {
		const stem = nameStem(expansion);
		const group = byStem.get(stem);
		if (group) group.add(expansion);
		else byStem.set(stem, new Set([expansion]));
	}

	const names = new Map<string, string>();
	const used = new Set<string>(reserved);
	// Pass 1: a uniquely-stemmed expansion claims the bare stem, unless a reserved
	// (pinned) name already holds it — then it defers to disambiguation so the two
	// never collide.
	const deferred: string[] = [];
	for (const stem of [...byStem.keys()].sort()) {
		const group = byStem.get(stem)!;
		if (group.size === 1 && !used.has(stem)) {
			const only = [...group][0]!;
			names.set(only, stem);
			used.add(stem);
		} else {
			for (const expansion of group) deferred.push(expansion);
		}
	}
	// Pass 2: every remaining expansion gets `stem` + the shortest hash prefix that
	// is not yet used. `used` already holds all bare stems and reserved names, so a
	// disambiguated name can never equal one of those.
	for (const expansion of deferred.sort()) {
		const stem = nameStem(expansion);
		const hash = fnv1a(expansion, 0x811c9dc5).toString(36) + fnv1a(expansion, 0x9e3779b1).toString(36);
		let name = `${stem}${hash}`; // full-hash fallback; only if every prefix is taken
		for (let len = 2; len <= hash.length; len++) {
			const candidate = `${stem}${hash.slice(0, len)}`;
			if (!used.has(candidate)) {
				name = candidate;
				break;
			}
		}
		names.set(expansion, name);
		used.add(name);
	}
	return names;
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
	/** Raw occurrence count across all samples. */
	frequency: number;
	/** Number of distinct samples the string appeared in (centrality). */
	documentFrequency: number;
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
	const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
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
	// result is deterministic when scores tie. Each sample contributes at most one
	// to a string's document frequency no matter how many times it repeats inside
	// that sample, so a single high-repetition file cannot dominate the ranking;
	// raw occurrences are tallied separately for reporting and the damped
	// within-sample bonus (see scoringFrequency).
	const seen = new Map<string, Candidate>();
	let ordinal = 0;
	for (const sample of samples) {
		const seenInSample = new Set<string>();
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
			const firstInSample = !seenInSample.has(expansion);
			if (firstInSample) {
				seenInSample.add(expansion);
			}
			const existing = seen.get(expansion);
			if (existing) {
				existing.frequency += 1;
				if (firstInSample) {
					existing.documentFrequency += 1;
				}
			} else {
				seen.set(expansion, { expansion, frequency: 1, documentFrequency: 1, firstSeen: ordinal++ });
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
		// Value is driven by centrality (document frequency), not raw occurrences,
		// so a string repeated inside one asset file cannot buy budget a model would
		// never spend on it. See scoringFrequency.
		const value = scoringFrequency(candidate.frequency, candidate.documentFrequency);
		scored.push({ candidate, savedTokens: perUse * value, handleTokens });
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

	// Precompute mnemonic names for the whole candidate set up front, so each name
	// is a pure function of the set (not of which entries the budget happens to fit
	// this run) and stays byte-identical across independent generators of the same
	// cache entry. Names avoid every pinned name. Only used when naming is mnemonic;
	// numeric/content assign per-entry below.
	const mnemonicNames =
		naming === "mnemonic"
			? buildMnemonicNames(
					scored.map(entry => entry.candidate.expansion),
					pinnedNames,
				)
			: undefined;

	// Frozen base: retain every pinned binding verbatim, scored by its frequency in
	// the current corpus (0 if the string no longer appears). Always counted toward
	// dictTokens, even past the budget — dropping a taught handle would break any
	// text that already used it.
	const pinnedHandles: GeneratedHandle[] = [];
	for (const [name, expansion] of pinnedEntries) {
		const candidate = seen.get(expansion);
		const frequency = candidate?.frequency ?? 0;
		const documentFrequency = candidate?.documentFrequency ?? 0;
		const perUse = countTokens(expansion) - countTokens(sigil + name);
		const entryTokens = countTokens(`${name} = "${expansion}"`);
		dictTokens += entryTokens;
		pinnedHandles.push({
			name,
			expansion,
			frequency,
			documentFrequency,
			savedTokens: Math.max(0, perUse) * scoringFrequency(frequency, documentFrequency),
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
					: (mnemonicNames?.get(entry.candidate.expansion) ?? nameStem(entry.candidate.expansion));
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
			documentFrequency: entry.candidate.documentFrequency,
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
