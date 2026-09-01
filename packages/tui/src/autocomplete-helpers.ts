import { isSubsequenceMatch, subsequenceScore } from "./fuzzy";

export const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

export function buildAutocompleteFuzzyDiscoveryProfile(
	query: string,
	basePath: string,
): {
	query: string;
	path: string;
	maxResults: number;
	hidden: boolean;
	gitignore: boolean;
	cache: boolean;
} {
	return {
		query,
		path: basePath,
		maxResults: 100,
		hidden: true,
		gitignore: true,
		cache: true,
	};
}

export function findLastDelimiter(text: string): number {
	for (let i = text.length - 1; i >= 0; i -= 1) {
		if (PATH_DELIMITERS.has(text[i] ?? "")) {
			return i;
		}
	}
	return -1;
}

function findUnclosedQuoteStart(text: string): number | null {
	let inQuotes = false;
	let quoteStart = -1;

	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === '"') {
			inQuotes = !inQuotes;
			if (inQuotes) {
				quoteStart = i;
			}
		}
	}

	return inQuotes ? quoteStart : null;
}

function isTokenStart(text: string, index: number): boolean {
	return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? "");
}

export function findLeadingSlashCommandStart(text: string): number | null {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("/")) return null;
	return text.length - trimmed.length;
}

export function findTrailingSlashCommandStart(text: string): number | null {
	const match = /(?:^|\s)\/([^\s/]*)$/.exec(text);
	if (!match || match.index === undefined) return null;
	const slashOffset = match[0].indexOf("/");
	return match.index + slashOffset;
}

export function extractQuotedPrefix(text: string): string | null {
	const quoteStart = findUnclosedQuoteStart(text);
	if (quoteStart === null) {
		return null;
	}

	if (quoteStart > 0 && text[quoteStart - 1] === "@") {
		if (!isTokenStart(text, quoteStart - 1)) {
			return null;
		}
		return text.slice(quoteStart - 1);
	}

	if (!isTokenStart(text, quoteStart)) {
		return null;
	}

	return text.slice(quoteStart);
}

export function parsePathPrefix(prefix: string): { rawPrefix: string; isAtPrefix: boolean; isQuotedPrefix: boolean } {
	if (prefix.startsWith('@"')) {
		return { rawPrefix: prefix.slice(2), isAtPrefix: true, isQuotedPrefix: true };
	}
	if (prefix.startsWith('"')) {
		return { rawPrefix: prefix.slice(1), isAtPrefix: false, isQuotedPrefix: true };
	}
	if (prefix.startsWith("@")) {
		return { rawPrefix: prefix.slice(1), isAtPrefix: true, isQuotedPrefix: false };
	}
	return { rawPrefix: prefix, isAtPrefix: false, isQuotedPrefix: false };
}

export function buildCompletionValue(
	path: string,
	options: { isDirectory: boolean; isAtPrefix: boolean; isQuotedPrefix: boolean },
): string {
	const needsQuotes = options.isQuotedPrefix || path.includes(" ");
	const prefix = options.isAtPrefix ? "@" : "";

	if (!needsQuotes) {
		return `${prefix}${path}`;
	}

	const openQuote = `${prefix}"`;
	const closeQuote = options.isDirectory ? "" : '"';
	return `${openQuote}${path}${closeQuote}`;
}

export interface AutocompleteItem {
	value: string;
	label: string;
	description?: string;
	hint?: string;
	group?: string;
}

export type Awaitable<T> = T | Promise<T>;

export interface SlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	argumentHint?: string;
	category?: string;
	allowArgs?: boolean;
	getAutocompleteDescription?: () => string | undefined;
	getArgumentCompletions?(argumentPrefix: string): Awaitable<AutocompleteItem[] | null>;
	getInlineHint?(argumentText: string): string | null;
}

export interface AutocompleteProvider {
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): Promise<{
		items: AutocompleteItem[];
		prefix: string; // What we're matching against (e.g., "/" or "src/")
	} | null>;

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): {
		lines: string[];
		cursorLine: number;
		cursorCol: number;
		onApplied?: () => void;
	};

	getInlineHint?(lines: string[], cursorLine: number, cursorCol: number): string | null;
	trySyncSlashCompletion?(textBeforeCursor: string): { items: AutocompleteItem[]; prefix: string } | null;
	trySyncInlineReplace?(textBeforeCursor: string): { replaceLen: number; insert: string } | null;

	getForceFileSuggestions?(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null>;

	shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}

export type CommandEntry = SlashCommand | AutocompleteItem;

function getCommandName(cmd: CommandEntry): string | undefined {
	return "name" in cmd ? cmd.name : cmd.value;
}

function getCommandAliases(cmd: CommandEntry): string[] {
	if (!("aliases" in cmd) || !Array.isArray(cmd.aliases)) return [];
	return cmd.aliases.filter(alias => typeof alias === "string" && alias.length > 0);
}

function getStaticCommandDescription(cmd: CommandEntry): string {
	return cmd.description ?? "";
}

function getAutocompleteCommandDescription(cmd: CommandEntry): string {
	if ("getAutocompleteDescription" in cmd && typeof cmd.getAutocompleteDescription === "function") {
		return cmd.getAutocompleteDescription() ?? cmd.description ?? "";
	}
	return cmd.description ?? "";
}

export function commandMatchesNameOrAlias(cmd: CommandEntry, commandName: string): boolean {
	const name = getCommandName(cmd);
	if (name === commandName) return true;
	return getCommandAliases(cmd).includes(commandName);
}

export function scoreCommandTextMatch(lowerPrefix: string, lowerTarget: string): number {
	if (lowerPrefix.length === 0) return 1;
	if (lowerPrefix === lowerTarget) return 1000;
	if (lowerTarget.startsWith(lowerPrefix)) return 900;
	return isSubsequenceMatch(lowerPrefix, lowerTarget) ? subsequenceScore(lowerPrefix, lowerTarget) : 0;
}

export function buildSlashCommandCompletions(
	commands: CommandEntry[],
	lowerPrefix: string,
	preferredCategoryOrder?: readonly string[],
): AutocompleteItem[] {
	const browsing = lowerPrefix.length === 0;
	const categoryOrder = new Map<string, number>();
	if (browsing) {
		const preferred = preferredCategoryOrder ?? [];
		for (let ci = 0; ci < preferred.length; ci++) {
			if (!categoryOrder.has(preferred[ci]!)) categoryOrder.set(preferred[ci]!, categoryOrder.size);
		}
		for (let ci = 0; ci < commands.length; ci++) {
			const cmd = commands[ci]!;
			const category = "category" in cmd ? cmd.category : undefined;
			if (category && !categoryOrder.has(category)) categoryOrder.set(category, categoryOrder.size);
		}
	}
	const ranked: Array<AutocompleteItem & { score: number }> = [];
	for (let ci = 0; ci < commands.length; ci++) {
		const cmd = commands[ci]!;
		const name = getCommandName(cmd);
		if (!name) continue;
		const category = browsing && "category" in cmd ? cmd.category : undefined;
		const hint = "argumentHint" in cmd && cmd.argumentHint ? cmd.argumentHint : undefined;
		const staticDesc = getStaticCommandDescription(cmd);
		let fullDescMemo: string | undefined;
		let fullDescComputed = false;
		const resolveFullDesc = (): string | undefined => {
			if (!fullDescComputed) {
				const displayDesc = getAutocompleteCommandDescription(cmd);
				fullDescMemo = hint ? (displayDesc ? `${hint} - ${displayDesc}` : hint) : displayDesc;
				fullDescComputed = true;
			}
			return fullDescMemo;
		};

		const isSkillCommand = name.startsWith("skill:");
		const nameScore =
			lowerPrefix.length === 0 && isSkillCommand ? 950 : scoreCommandTextMatch(lowerPrefix, name.toLowerCase());
		const lowerDesc = staticDesc.toLowerCase();
		const descScore =
			lowerDesc && isSubsequenceMatch(lowerPrefix, lowerDesc) ? subsequenceScore(lowerPrefix, lowerDesc) * 0.5 : 0;
		const primaryScore = Math.max(nameScore, descScore);
		if (primaryScore > 0) {
			const fullDesc = resolveFullDesc();
			ranked.push({
				value: name,
				label: "name" in cmd ? cmd.name : cmd.label,
				score: primaryScore,
				...(fullDesc && { description: fullDesc }),
				...(category && { group: category }),
			});
		}

		if (lowerPrefix.length > 0 && nameScore === 0) {
			const aliases = getCommandAliases(cmd);
			for (let ai = 0; ai < aliases.length; ai++) {
				const alias = aliases[ai]!;
				if (alias === name) continue;
				const aliasScore = scoreCommandTextMatch(lowerPrefix, alias.toLowerCase());
				if (aliasScore === 0) continue;
				const fullDesc = resolveFullDesc();
				ranked.push({
					value: alias,
					label: alias,
					score: aliasScore,
					...(fullDesc && { description: fullDesc }),
				});
			}
		}
	}
	ranked.sort((a, b) => b.score - a.score);
	if (browsing) {
		const rank = (g: string | undefined): number =>
			g === undefined ? Number.MAX_SAFE_INTEGER : (categoryOrder.get(g) ?? Number.MAX_SAFE_INTEGER);
		ranked.sort((a, b) => rank(a.group) - rank(b.group) || b.score - a.score);
	}
	const result = new Array<AutocompleteItem>(ranked.length);
	for (let ri = 0; ri < ranked.length; ri++) {
		const { score: _, ...rest } = ranked[ri]!;
		result[ri] = rest;
	}
	return result;
}

export function hasPromptTextBeforeSlash(
	lines: string[],
	cursorLine: number,
	textBeforeCursor: string,
	slashStart: number,
): boolean {
	for (let i = 0; i < cursorLine; i += 1) {
		if ((lines[i] || "").trim() !== "") return true;
	}
	return textBeforeCursor.slice(0, slashStart).trim() !== "";
}

export const SKILL_NAMESPACE = "skill:";

export function midPromptSkillTokenMatches(lowerToken: string, name: string, description?: string): boolean {
	if (SKILL_NAMESPACE.startsWith(lowerToken)) return true;
	const lowerName = name.toLowerCase();
	if (lowerToken.startsWith(SKILL_NAMESPACE)) {
		if (scoreCommandTextMatch(lowerToken, lowerName) > 0) return true;
		return !!description && scoreCommandTextMatch(lowerToken, description.toLowerCase()) > 0;
	}
	return lowerName.startsWith(SKILL_NAMESPACE) && lowerName.slice(SKILL_NAMESPACE.length).startsWith(lowerToken);
}

export function buildMidPromptSkillCompletions(commands: CommandEntry[], lowerPrefix: string): AutocompleteItem[] {
	return buildSlashCommandCompletions(
		commands.filter(cmd => {
			const name = getCommandName(cmd);
			return (
				name?.startsWith(SKILL_NAMESPACE) &&
				midPromptSkillTokenMatches(lowerPrefix, name, getStaticCommandDescription(cmd))
			);
		}),
		lowerPrefix,
	);
}

export interface CombinedAutocompleteProviderOptions {
	categoryOrder?: readonly string[];
}
