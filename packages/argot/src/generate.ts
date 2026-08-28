import {
	DEFAULT_OUTPUT_TO_INPUT_PRICE_RATIO,
	DEFAULT_SAVINGS_COVERAGE,
	DEFAULT_SIGIL,
	DEFAULT_TOKEN_BUDGET,
	DEFAULT_TOOL_CALL_STRUCTURE_SHARE,
	HANDLE_NAME_RE,
	MAX_EXPANSION_BYTES,
	SUPPORTED_VERSION,
} from "./constants.js";
import type { Vocabulary } from "./types.js";

const utf8 = new TextEncoder();

export type HandleNaming = "mnemonic" | "numeric" | "content";

export interface GenerateOptions {
	tokenBudget?: number;
	sigil?: string;
	minFrequency?: number;
	minExpansionLength?: number;
	maxHandles?: number;
	savingsCoverage?: number;
	naming?: HandleNaming;
	countTokens?: (text: string) => number;
	extract?: (text: string) => Iterable<string>;
	toolCallStructureShare?: number;
	pinned?: Vocabulary;
}

export interface GeneratedHandle {
	name: string;
	expansion: string;
	frequency: number;
	documentFrequency: number;
	savedTokens: number;
	dictTokens: number;
}

export function scoringFrequency(rawFrequency: number, documentFrequency: number): number {
	const within = Math.max(0, rawFrequency - documentFrequency);
	return documentFrequency + Math.floor(Math.log2(1 + within));
}

export interface GeneratedDict {
	vocab: Vocabulary;
	toml: string;
	handles: GeneratedHandle[];
	dictTokens: number;
	estimatedSavings: number;
	breakEvenTurns: number;
	tokenBudget: number;
	candidatesConsidered: number;
}

export function estimateTokens(text: string): number {
	if (text.length === 0) {
		return 0;
	}
	let tokens = 0;
	const words = text.match(/[A-Za-z0-9]+/g) ?? [];
	for (const word of words) {
		tokens += Math.max(1, Math.ceil(word.length / 4));
	}
	const symbols = text.replace(/[A-Za-z0-9\s]/g, "").length;
	tokens += symbols;
	return Math.max(1, tokens);
}

function isLineStructure(expansion: string): boolean {
	return expansion.startsWith("\n");
}

function lineStructureCandidates(rawLine: string, trimmed: string, previousLine: string | undefined): string[] {
	const firstWord = /^[A-Za-z_][A-Za-z0-9_]{0,15}/.exec(trimmed)?.[0];
	if (firstWord === undefined) {
		return [];
	}
	const out: string[] = [];
	const indent = /^[\t ]+/.exec(rawLine)?.[0];
	if (indent !== undefined) {
		out.push(`\n${indent}${firstWord}`);
		out.push(`\n${indent}`);
	} else if (previousLine !== undefined && previousLine.trim().length === 0) {
		out.push(`\n\n${firstWord}`);
	}
	return out;
}

export function emittedTokenCost(
	expansion: string,
	countTokens: (text: string) => number,
	toolCallStructureShare: number = DEFAULT_TOOL_CALL_STRUCTURE_SHARE,
): number {
	if (!Number.isFinite(toolCallStructureShare) || toolCallStructureShare < 0 || toolCallStructureShare > 1) {
		throw new RangeError(
			`toolCallStructureShare must be between 0 and 1, got ${toolCallStructureShare}. It is the measured share of line structure emitted inside tool-call arguments; see DEFAULT_TOOL_CALL_STRUCTURE_SHARE.`,
		);
	}
	if (!isLineStructure(expansion)) {
		return countTokens(expansion);
	}
	const escaped = countTokens(JSON.stringify(expansion).slice(1, -1));
	const raw = countTokens(expansion);
	return toolCallStructureShare * escaped + (1 - toolCallStructureShare) * raw;
}

function trimWrapping(token: string): string {
	return token.replace(/^[["'`(<{]+/, "").replace(/[\]"'`)>},;]+$/, "");
}

const CODE_PUNCTUATION = /[(){}[\]`'"$;,=<>!?*|&]/;

function isReusableToken(token: string): boolean {
	if (CODE_PUNCTUATION.test(token)) {
		return false;
	}
	if (/:\/\//.test(token)) {
		return false;
	}
	return /[/\\]/.test(token) || /::/.test(token);
}

function isReferenceNoiseLine(line: string): boolean {
	if (/\[!\[/.test(line) || /\]\(\s*<?https?:\/\//.test(line)) {
		return true;
	}
	if (/^[0-9a-fA-F]{8}\b(?:\s+[0-9a-fA-F]{2}\b){2,}/.test(line)) {
		return true;
	}
	return false;
}

function isStructured(token: string): boolean {
	return /[/\\]/.test(token) || /\w\.\w/.test(token) || /::/.test(token) || /:\/\//.test(token);
}

function looksLikeCommand(tokens: string[]): boolean {
	if (!tokens.some(t => isStructured(t) || /^-{1,2}\w/.test(t) || /^\w[\w-]*=/.test(t))) {
		return false;
	}
	return !looksLikeProse(tokens);
}

function looksLikeProse(tokens: string[]): boolean {
	if (tokens.some(t => /^[A-Za-z0-9][\w-]*,$/.test(t))) {
		return true;
	}
	let run = 0;
	for (const token of tokens) {
		const bare = token.replace(/^["'`(]+/, "").replace(/["'`).,;:!?]+$/, "");
		if (/^[A-Za-z][A-Za-z-]+$/.test(bare)) {
			run++;
			if (run >= 5) return true;
		} else {
			run = 0;
		}
	}
	return /^[A-Z][a-z]+$/.test(tokens[0] ?? "");
}

function looksLikeSourceCode(line: string): boolean {
	if (/[;`{}]/.test(line) || /=>/.test(line) || /\w\(/.test(line)) {
		return true;
	}
	if (/^\(/.test(line)) {
		return true;
	}
	if (/\?\.|\?\?|!==|===/.test(line)) {
		return true;
	}
	if (/(\|\||&&|\?\?|[,+*=<>?:])$/.test(line)) {
		return true;
	}
	const firstWord = (line.split(/\s+/, 1)[0] ?? "").replace(/[^A-Za-z]/g, "");
	return SOURCE_KEYWORDS.has(firstWord);
}

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

function isCommentLine(line: string): boolean {
	return /^(#|\/\/|\/\*|\*|<!--|--)/.test(line);
}

export function extractCandidates(text: string): string[] {
	const out: string[] = [];
	const lines = text.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const rawLine = lines[index] as string;
		const line = rawLine.trim();
		if (line.length === 0) {
			continue;
		}
		for (const structure of lineStructureCandidates(rawLine, line, index === 0 ? undefined : lines[index - 1])) {
			out.push(structure);
		}
		const rawTokens = line.split(/\s+/);
		if (
			/\s/.test(line) &&
			!isCommentLine(line) &&
			!isReferenceNoiseLine(line) &&
			looksLikeCommand(rawTokens) &&
			!looksLikeSourceCode(line)
		) {
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

const MAX_NAME_LENGTH = 4;

const CONTENT_NAME_STEM_LENGTH = 6;

function nameStem(expansion: string, maxLength: number = MAX_NAME_LENGTH): string {
	const segment = expansion.split(/[/\\]/).filter(Boolean).pop() ?? expansion;
	let base = segment
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "")
		.slice(0, maxLength);
	if (base.length === 0) {
		base = expansion
			.toLowerCase()
			.replace(/[^a-z0-9_]+/g, "")
			.slice(0, maxLength);
	}
	return base.length === 0 ? "h" : base;
}

function fnv1a(text: string, seed: number): number {
	let hash = seed >>> 0;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

function contentName(expansion: string): string {
	const hash = fnv1a(expansion, 0x811c9dc5).toString(36) + fnv1a(expansion, 0x9e3779b1).toString(36);
	return `${nameStem(expansion, CONTENT_NAME_STEM_LENGTH)}_${hash.slice(0, 8)}`;
}

function buildMnemonicNames(allExpansions: Iterable<string>, reserved: Iterable<string> = []): Map<string, string> {
	const byStem = new Map<string, Set<string>>();
	for (const expansion of allExpansions) {
		const stem = nameStem(expansion);
		const group = byStem.get(stem);
		if (group) group.add(expansion);
		else byStem.set(stem, new Set([expansion]));
	}

	const names = new Map<string, string>();
	const used = new Set<string>(reserved);
	const deferred: string[] = [];
	for (const stem of Array.from(byStem.keys()).sort()) {
		const group = byStem.get(stem)!;
		if (group.size === 1 && !used.has(stem)) {
			const only = Array.from(group)[0]!;
			names.set(only, stem);
			used.add(stem);
		} else {
			for (const expansion of group) deferred.push(expansion);
		}
	}
	for (const expansion of deferred.sort()) {
		const hash = fnv1a(expansion, 0x811c9dc5).toString(36) + fnv1a(expansion, 0x9e3779b1).toString(36);
		let name: string | undefined;
		for (let suffixLength = 1; suffixLength < MAX_NAME_LENGTH && name === undefined; suffixLength++) {
			const stem = nameStem(expansion).slice(0, MAX_NAME_LENGTH - suffixLength);
			for (let start = 0; start + suffixLength <= hash.length; start++) {
				const candidate = `${stem}${hash.slice(start, start + suffixLength)}`;
				if (!used.has(candidate)) {
					name = candidate;
					break;
				}
			}
		}
		if (name === undefined) {
			let overflow = 0;
			do {
				overflow++;
				name = `${nameStem(expansion).slice(0, 1)}${overflow.toString(36)}`;
			} while (used.has(name));
		}
		names.set(expansion, name);
		used.add(name);
	}
	return names;
}

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

function toToml(sigil: string, handles: GeneratedHandle[]): string {
	const lines: string[] = [];
	lines.push("# Generated by argot. Review before committing: a handle must stand");
	lines.push("# for exactly the string it replaces. Edit freely; this is just a start.");
	lines.push(`version = ${SUPPORTED_VERSION}`);
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
	documentFrequency: number;
	firstSeen: number;
}

export interface RepoFile {
	path: string;
	content?: string;
}

export function generateDict(corpus: string | string[], options: GenerateOptions = {}): GeneratedDict {
	const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
	const pinnedEntries: Array<[string, string]> = options.pinned ? Array.from(options.pinned.handles) : [];
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
	const toolCallStructureShare = options.toolCallStructureShare ?? DEFAULT_TOOL_CALL_STRUCTURE_SHARE;
	const samples = typeof corpus === "string" ? [corpus] : corpus;

	const seen = new Map<string, Candidate>();
	let ordinal = 0;
	for (const sample of samples) {
		const seenInSample = new Set<string>();
		for (const rawExpansion of extract(sample)) {
			const expansion = rawExpansion;
			if (!isLineStructure(expansion) && expansion.length < minExpansionLength) {
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

	const scored: Array<{ candidate: Candidate; savedTokens: number; handleTokens: number }> = [];
	let numericProbe = 0;
	for (const candidate of seen.values()) {
		if (candidate.frequency < minFrequency) {
			continue;
		}
		if (pinnedExpansions.has(candidate.expansion)) {
			continue; // already has a frozen handle; never propose a second one
		}
		const probeName =
			naming === "numeric"
				? String(++numericProbe)
				: naming === "content"
					? contentName(candidate.expansion)
					: "abcd";
		const handleTokens = countTokens(sigil + probeName);
		const expansionTokens = emittedTokenCost(candidate.expansion, countTokens, toolCallStructureShare);
		const perUse = expansionTokens - handleTokens;
		if (perUse <= 0) {
			continue; // the handle is not shorter than what it replaces
		}
		let value: number;
		if (isLineStructure(candidate.expansion)) {
			if (candidate.documentFrequency < 2) {
				continue;
			}
			value = candidate.frequency;
		} else {
			value = scoringFrequency(candidate.frequency, candidate.documentFrequency);
		}
		scored.push({ candidate, savedTokens: perUse * value, handleTokens });
	}

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

	const headerTokens = countTokens(
		sigil !== DEFAULT_SIGIL
			? `version = ${SUPPORTED_VERSION}\nsigil = "${sigil}"\n\n[handles]\n`
			: `version = ${SUPPORTED_VERSION}\n\n[handles]\n`,
	);
	const taken = new Set<string>(pinnedNames);
	let dictTokens = headerTokens;

	const mnemonicNames =
		naming === "mnemonic"
			? buildMnemonicNames(
					scored.map(entry => entry.candidate.expansion),
					pinnedNames,
				)
			: undefined;

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

	let numeric = 0;
	if (naming === "numeric") {
		for (const name of pinnedNames) {
			const n = Number(name);
			if (Number.isInteger(n) && n > numeric) {
				numeric = n;
			}
		}
	}

	const feasible: GeneratedHandle[] = [];
	let feasibleTokens = 0;
	for (const entry of scored) {
		if (options.maxHandles !== undefined && pinnedHandles.length + feasible.length >= options.maxHandles) {
			break;
		}
		const name =
			naming === "numeric"
				? String(++numeric)
				: naming === "content"
					? contentName(entry.candidate.expansion)
					: (mnemonicNames?.get(entry.candidate.expansion) ?? nameStem(entry.candidate.expansion));
		if (!HANDLE_NAME_RE.test(name)) {
			continue;
		}
		if (taken.has(name)) {
			continue;
		}
		const entryTokens = countTokens(`${name} = "${entry.candidate.expansion}"`);
		if (dictTokens + feasibleTokens + entryTokens > tokenBudget) {
			continue; // does not fit; a smaller later entry still might
		}
		taken.add(name);
		feasibleTokens += entryTokens;
		feasible.push({
			name,
			expansion: entry.candidate.expansion,
			frequency: entry.candidate.frequency,
			documentFrequency: entry.candidate.documentFrequency,
			savedTokens: entry.savedTokens,
			dictTokens: entryTokens,
		});
	}

	const coverage = options.savingsCoverage ?? DEFAULT_SAVINGS_COVERAGE;
	const pinnedSavings = pinnedHandles.reduce((sum, h) => sum + h.savedTokens, 0);
	const achievableSavings = pinnedSavings + feasible.reduce((sum, h) => sum + h.savedTokens, 0);
	const savingsTarget = coverage >= 1 ? Number.POSITIVE_INFINITY : achievableSavings * coverage;
	const chosenNew: GeneratedHandle[] = [];
	let selectedSavings = pinnedSavings;
	for (const handle of feasible) {
		if (selectedSavings >= savingsTarget) {
			taken.delete(handle.name);
			continue;
		}
		selectedSavings += handle.savedTokens;
		dictTokens += handle.dictTokens;
		chosenNew.push(handle);
	}

	const chosen: GeneratedHandle[] = pinnedHandles.concat(chosenNew).sort((a, b) => {
		if (b.savedTokens !== a.savedTokens) {
			return b.savedTokens - a.savedTokens;
		}
		return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
	});

	const handleMap = new Map<string, string>();
	for (const handle of chosen) {
		handleMap.set(handle.name, handle.expansion);
	}
	const vocab: Vocabulary = { version: SUPPORTED_VERSION, sigil, handles: handleMap, meta: new Map() };
	const toml = chosen.length > 0 ? toToml(sigil, chosen) : "";
	const estimatedSavings = chosen.reduce((sum, h) => sum + h.savedTokens, 0);
	const carriedPerTurn = chosen.length > 0 ? dictTokens : 0;
	const breakEvenTurns =
		carriedPerTurn === 0
			? Number.POSITIVE_INFINITY
			: (estimatedSavings * DEFAULT_OUTPUT_TO_INPUT_PRICE_RATIO) / carriedPerTurn;

	return {
		vocab,
		toml,
		handles: chosen,
		dictTokens: carriedPerTurn,
		estimatedSavings,
		breakEvenTurns,
		tokenBudget,
		candidatesConsidered,
	};
}

export function generateDictFromRepo(files: RepoFile[], options: GenerateOptions = {}): GeneratedDict {
	const samples: string[] = [];
	for (const file of files) {
		samples.push(file.path);
	}
	for (const file of files) {
		if (file.content !== undefined) {
			samples.push(file.content);
		}
	}
	return generateDict(samples, { minFrequency: 1, ...options });
}
