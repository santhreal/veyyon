import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fuzzyFind } from "@veyyon/natives";
import { getProjectDir } from "@veyyon/utils/dirs";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	CombinedAutocompleteProviderOptions,
	CommandEntry,
} from "./autocomplete-helpers";

import {
	buildAutocompleteFuzzyDiscoveryProfile,
	buildCompletionValue,
	buildMidPromptSkillCompletions,
	buildSlashCommandCompletions,
	commandMatchesNameOrAlias,
	extractQuotedPrefix,
	findLastDelimiter,
	findLeadingSlashCommandStart,
	findTrailingSlashCommandStart,
	hasPromptTextBeforeSlash,
	parsePathPrefix,
} from "./autocomplete-helpers";
import { isSubsequenceMatch } from "./fuzzy";

export type { SlashCommand } from "./autocomplete-helpers";
export { midPromptSkillTokenMatches, scoreCommandTextMatch } from "./autocomplete-helpers";
export type { AutocompleteItem, AutocompleteProvider };
export { findLeadingSlashCommandStart, findTrailingSlashCommandStart };

export class CombinedAutocompleteProvider implements AutocompleteProvider {
	#commands: CommandEntry[];
	#basePath: string;
	#categoryOrder: readonly string[] | undefined;
	#dirCache: Map<string, { entries: fs.Dirent[]; timestamp: number }> = new Map();
	readonly #DIR_CACHE_TTL = 2000; // 2 seconds

	constructor(
		commands: CommandEntry[] = [],
		basePath: string = getProjectDir(),
		options: CombinedAutocompleteProviderOptions = {},
	) {
		this.#commands = commands;
		this.#basePath = basePath;
		this.#categoryOrder = options.categoryOrder;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		const leadingSlashStart = findLeadingSlashCommandStart(textBeforeCursor);
		const trailingSlashStart = findTrailingSlashCommandStart(textBeforeCursor);
		const hasPromptTextBeforeTrailingSlash =
			trailingSlashStart !== null &&
			hasPromptTextBeforeSlash(lines, cursorLine, textBeforeCursor, trailingSlashStart);
		const hasPromptTextBeforeLeadingSlash =
			leadingSlashStart !== null && hasPromptTextBeforeSlash(lines, cursorLine, textBeforeCursor, leadingSlashStart);
		const slashStart = hasPromptTextBeforeTrailingSlash
			? trailingSlashStart
			: hasPromptTextBeforeLeadingSlash
				? null
				: leadingSlashStart;
		if (slashStart !== null) {
			const commandText = textBeforeCursor.slice(slashStart);
			const spaceIndex = commandText.indexOf(" ");
			const isMidPromptSkillLookup = hasPromptTextBeforeTrailingSlash;

			if (spaceIndex === -1) {
				const prefix = commandText.slice(1); // Remove the "/"
				const lowerPrefix = prefix.toLowerCase();

				const matches = isMidPromptSkillLookup
					? buildMidPromptSkillCompletions(this.#commands, lowerPrefix)
					: buildSlashCommandCompletions(this.#commands, lowerPrefix, this.#categoryOrder);

				if (matches.length > 0) {
					return {
						items: matches,
						prefix: isMidPromptSkillLookup ? commandText : textBeforeCursor,
					};
				}
				if (!isMidPromptSkillLookup && slashStart === leadingSlashStart && !commandText.slice(1).includes("/")) {
					return null;
				}
			} else if (!isMidPromptSkillLookup) {
				const commandName = commandText.slice(1, spaceIndex); // Command without "/"
				const argumentText = commandText.slice(spaceIndex + 1); // Text after space

				const command = this.#commands.find(cmd => commandMatchesNameOrAlias(cmd, commandName));
				if (command && "allowArgs" in command && command.allowArgs === false && !/\S/.test(argumentText)) {
					return null;
				}
				if (command && (!("allowArgs" in command) || command.allowArgs !== false)) {
					if (!("getArgumentCompletions" in command) || !command.getArgumentCompletions) {
						return null; // No argument completion for this command
					}

					const argumentSuggestions = await command.getArgumentCompletions(argumentText);
					if (!Array.isArray(argumentSuggestions) || argumentSuggestions.length === 0) {
						return null;
					}

					return {
						items: argumentSuggestions,
						prefix: argumentText,
					};
				}
			}
		}

		const atPrefix = this.#extractAtPrefix(textBeforeCursor);
		if (atPrefix) {
			const { rawPrefix, isQuotedPrefix } = parsePathPrefix(atPrefix);
			if (rawPrefix.length > 0 && this.#isOutsideCwd(rawPrefix)) {
				const items = await this.#getFileSuggestions(atPrefix);
				if (items.length === 0) return null;
				return { items, prefix: atPrefix };
			}
			const suggestions =
				rawPrefix.length > 0
					? await this.#getFuzzyFileSuggestions(rawPrefix, { isQuotedPrefix })
					: await this.#getFileSuggestions("@");
			if (suggestions.length === 0 && rawPrefix.length > 0) {
				const fallback = await this.#getFileSuggestions(atPrefix);
				if (fallback.length === 0) return null;
				return { items: fallback, prefix: atPrefix };
			}
			if (suggestions.length === 0) return null;

			return {
				items: suggestions,
				prefix: atPrefix,
			};
		}

		const pathMatch = this.#extractPathPrefix(textBeforeCursor, false);

		if (pathMatch !== null) {
			const suggestions = await this.#getFileSuggestions(pathMatch);
			if (suggestions.length === 0) return null;

			if (suggestions.length === 1 && suggestions[0]?.value === pathMatch && !pathMatch.endsWith("/")) {
				return {
					items: suggestions,
					prefix: pathMatch,
				};
			}

			return {
				items: suggestions,
				prefix: pathMatch,
			};
		}

		return null;
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		const afterCursor = currentLine.slice(cursorCol);

		const leadingSlashStart = findLeadingSlashCommandStart(textBeforeCursor);
		const trailingSlashStart = findTrailingSlashCommandStart(textBeforeCursor);
		const isMidPromptSkillLookup =
			item.value.startsWith("skill:") &&
			trailingSlashStart !== null &&
			hasPromptTextBeforeSlash(lines, cursorLine, textBeforeCursor, trailingSlashStart) &&
			findTrailingSlashCommandStart(prefix) !== null;

		if (isMidPromptSkillLookup && trailingSlashStart !== null) {
			const beforeSlash = currentLine.slice(0, trailingSlashStart);
			const insert = `/${item.value} `;
			const newLine = `${beforeSlash}${insert}${afterCursor}`;
			const newLines = lines.slice();
			newLines[cursorLine] = newLine;
			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforeSlash.length + insert.length,
			};
		}

		const isPathCompletionItem = item.value.startsWith("/") || item.value.startsWith('"');
		if (findLeadingSlashCommandStart(prefix) !== null && leadingSlashStart !== null && !isPathCompletionItem) {
			const slashPrefix = textBeforeCursor.slice(leadingSlashStart);
			if (!slashPrefix.includes(" ") && !slashPrefix.slice(1).includes("/")) {
				const beforeSlash = currentLine.slice(0, leadingSlashStart);
				const newLine = `${beforeSlash}/${item.value} ${afterCursor}`;
				const newLines = lines.slice();
				newLines[cursorLine] = newLine;

				return {
					lines: newLines,
					cursorLine,
					cursorCol: beforeSlash.length + item.value.length + 2, // +2 for "/" and space
				};
			}
		}

		let beforePrefix = currentLine.slice(0, cursorCol - prefix.length);

		if (prefix.startsWith("@")) {
			const liveAtPrefix = this.#extractAtPrefix(textBeforeCursor);
			if (liveAtPrefix) {
				beforePrefix = currentLine.slice(0, cursorCol - liveAtPrefix.length);
			}
			const newLine = `${beforePrefix + item.value} ${afterCursor}`;
			const newLines = lines.slice();
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + 1, // +1 for space
			};
		}

		const newLine = beforePrefix + item.value + afterCursor;
		const newLines = lines.slice();
		newLines[cursorLine] = newLine;

		return {
			lines: newLines,
			cursorLine,
			cursorCol: beforePrefix.length + item.value.length,
		};
	}

	#extractAtPrefix(text: string): string | null {
		const quotedPrefix = extractQuotedPrefix(text);
		if (quotedPrefix?.startsWith('@"')) {
			return quotedPrefix;
		}

		const lastDelimiterIndex = findLastDelimiter(text);
		const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;

		if (text[tokenStart] === "@") {
			return text.slice(tokenStart);
		}

		return null;
	}

	#extractPathPrefix(text: string, forceExtract: boolean = false): string | null {
		const quotedPrefix = extractQuotedPrefix(text);
		if (quotedPrefix) {
			return quotedPrefix;
		}

		const lastDelimiterIndex = findLastDelimiter(text);
		const pathPrefix = lastDelimiterIndex === -1 ? text : text.slice(lastDelimiterIndex + 1);

		if (forceExtract) {
			return pathPrefix;
		}

		if (
			pathPrefix.startsWith("/") ||
			pathPrefix.startsWith("./") ||
			pathPrefix.startsWith("../") ||
			pathPrefix.startsWith("~/")
		) {
			return pathPrefix;
		}

		return null;
	}

	#expandHomePath(filePath: string): string {
		if (filePath.startsWith("~/")) {
			const expandedPath = path.join(os.homedir(), filePath.slice(2));
			return filePath.endsWith("/") && !expandedPath.endsWith("/") ? `${expandedPath}/` : expandedPath;
		} else if (filePath === "~") {
			return os.homedir();
		}
		return filePath;
	}

	#isOutsideCwd(rawPrefix: string): boolean {
		if (rawPrefix.length === 0) return false;
		let target: string;
		if (rawPrefix.startsWith("~")) {
			target = this.#expandHomePath(rawPrefix);
		} else if (path.isAbsolute(rawPrefix)) {
			target = rawPrefix;
		} else {
			target = path.resolve(this.#basePath, rawPrefix);
		}
		const rel = path.relative(this.#basePath, target);
		if (rel === "" || rel === ".") return false;
		if (path.isAbsolute(rel)) return true;
		const firstSep = rel.indexOf(path.sep);
		const head = firstSep === -1 ? rel : rel.slice(0, firstSep);
		return head === "..";
	}

	async #resolveScopedFuzzyQuery(
		rawQuery: string,
	): Promise<{ baseDir: string; query: string; displayBase: string } | null> {
		const slashIndex = rawQuery.lastIndexOf("/");
		if (slashIndex === -1) {
			return null;
		}

		const displayBase = rawQuery.slice(0, slashIndex + 1);
		const query = rawQuery.slice(slashIndex + 1);

		let baseDir: string;
		if (displayBase.startsWith("~/")) {
			baseDir = this.#expandHomePath(displayBase);
		} else if (displayBase.startsWith("/")) {
			baseDir = displayBase;
		} else {
			baseDir = path.join(this.#basePath, displayBase);
		}

		try {
			if (!(await fs.promises.stat(baseDir)).isDirectory()) {
				return null;
			}
		} catch {
			return null;
		}

		return { baseDir, query, displayBase };
	}

	#scopedPathForDisplay(displayBase: string, relativePath: string): string {
		if (displayBase === "/") {
			return `/${relativePath}`;
		}
		return `${displayBase}${relativePath}`;
	}

	async #getCachedDirEntries(searchDir: string): Promise<fs.Dirent[]> {
		const now = Date.now();
		const cached = this.#dirCache.get(searchDir);

		if (cached && now - cached.timestamp < this.#DIR_CACHE_TTL) {
			return cached.entries;
		}

		const entries = await fs.promises.readdir(searchDir, { withFileTypes: true });
		this.#dirCache.set(searchDir, { entries, timestamp: now });

		if (this.#dirCache.size > 100) {
			const sortedKeys = Array.from(this.#dirCache.entries())
				.sort((a, b) => a[1].timestamp - b[1].timestamp)
				.slice(0, 50)
				.map(([key]) => key);
			for (const key of sortedKeys) {
				this.#dirCache.delete(key);
			}
		}

		return entries;
	}

	invalidateDirCache(dir?: string): void {
		if (dir) {
			this.#dirCache.delete(dir);
		} else {
			this.#dirCache.clear();
		}
	}

	async #getFileSuggestions(prefix: string): Promise<AutocompleteItem[]> {
		try {
			let searchDir: string;
			let searchPrefix: string;
			const { rawPrefix, isAtPrefix, isQuotedPrefix } = parsePathPrefix(prefix);
			let expandedPrefix = rawPrefix;

			expandedPrefix = expandedPrefix.replace(/\\/g, "/");

			const preExpand = expandedPrefix;

			if (expandedPrefix.startsWith("~")) {
				expandedPrefix = this.#expandHomePath(expandedPrefix);
			}

			const isRootPrefix =
				preExpand === "" ||
				preExpand === "./" ||
				preExpand === "../" ||
				preExpand === "~" ||
				preExpand === "~/" ||
				preExpand === "/" ||
				(isAtPrefix && preExpand === "");

			if (isRootPrefix) {
				if (expandedPrefix.startsWith("~") || path.isAbsolute(expandedPrefix)) {
					searchDir = expandedPrefix;
				} else {
					searchDir = path.join(this.#basePath, expandedPrefix);
				}
				searchPrefix = "";
			} else if (expandedPrefix.endsWith("/")) {
				if (expandedPrefix.startsWith("~") || path.isAbsolute(expandedPrefix)) {
					searchDir = expandedPrefix;
				} else {
					searchDir = path.join(this.#basePath, expandedPrefix);
				}
				searchPrefix = "";
			} else {
				const dir = path.dirname(expandedPrefix);
				const file = path.basename(expandedPrefix);
				if (expandedPrefix.startsWith("~") || path.isAbsolute(expandedPrefix)) {
					searchDir = dir;
				} else {
					searchDir = path.join(this.#basePath, dir);
				}
				searchPrefix = file;
			}

			const entries = await this.#getCachedDirEntries(searchDir);
			const suggestions: AutocompleteItem[] = [];

			for (let ei = 0; ei < entries.length; ei++) {
				const entry = entries[ei]!;
				if (!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())) {
					continue;
				}
				if (entry.name === ".git") {
					continue;
				}

				let isDirectory = entry.isDirectory();
				if (!isDirectory && entry.isSymbolicLink()) {
					try {
						const fullPath = path.join(searchDir, entry.name);
						isDirectory = (await fs.promises.stat(fullPath)).isDirectory();
					} catch {
						continue;
					}
				}

				let relativePath: string;
				const name = entry.name;
				const displayPrefix = rawPrefix.replace(/\\/g, "/");

				if (displayPrefix.endsWith("/")) {
					relativePath = displayPrefix + name;
				} else if (displayPrefix.includes("/")) {
					if (displayPrefix.startsWith("~/")) {
						const homeRelativeDir = displayPrefix.slice(2); // Remove ~/
						const dir = path.dirname(homeRelativeDir);
						relativePath = `~/${dir === "." ? name : path.join(dir, name)}`;
					} else if (path.isAbsolute(displayPrefix)) {
						const dir = displayPrefix.slice(0, displayPrefix.lastIndexOf("/"));
						relativePath = dir === "" || dir === "/" ? `/${name}` : `${dir}/${name}`;
					} else {
						relativePath = path.join(path.dirname(displayPrefix), name);
						if (displayPrefix.startsWith("./") && !relativePath.startsWith("./")) {
							relativePath = `./${relativePath}`;
						}
					}
				} else {
					if (displayPrefix.startsWith("~")) {
						relativePath = `~/${name}`;
					} else {
						relativePath = name;
					}
				}

				relativePath = relativePath.replace(/\\/g, "/");
				const pathValue = isDirectory ? `${relativePath}/` : relativePath;
				const value = buildCompletionValue(pathValue, {
					isDirectory,
					isAtPrefix,
					isQuotedPrefix,
				});

				suggestions.push({
					value,
					label: name + (isDirectory ? "/" : ""),
				});
			}

			suggestions.sort((a, b) => {
				const aIsDir = a.value.endsWith("/");
				const bIsDir = b.value.endsWith("/");
				if (aIsDir && !bIsDir) return -1;
				if (!aIsDir && bIsDir) return 1;
				return a.label.localeCompare(b.label);
			});

			return suggestions;
		} catch {
			return [];
		}
	}

	async #getFuzzyFileSuggestions(query: string, options: { isQuotedPrefix: boolean }): Promise<AutocompleteItem[]> {
		try {
			const scopedQuery = await this.#resolveScopedFuzzyQuery(query);
			const searchPath = scopedQuery?.baseDir ?? this.#basePath;
			const fuzzyQuery = scopedQuery?.query ?? query;
			const result = await fuzzyFind(buildAutocompleteFuzzyDiscoveryProfile(fuzzyQuery, searchPath));
			const lowerQuery = fuzzyQuery.toLowerCase();
			const filteredMatches: typeof result.matches = [];
			for (let mi = 0; mi < result.matches.length; mi++) {
				const entry = result.matches[mi]!;
				const p = entry.path.endsWith("/") ? entry.path.slice(0, -1) : entry.path;
				const normalized = p.replaceAll("\\", "/");
				if (/(^|\/)\.git(\/|$)/.test(normalized)) {
					continue;
				}
				if (lowerQuery.length > 0 && !isSubsequenceMatch(lowerQuery, normalized.toLowerCase())) {
					continue;
				}
				filteredMatches.push(entry);
			}
			const topEntries = filteredMatches;
			const suggestions: AutocompleteItem[] = [];
			for (let ti = 0; ti < topEntries.length; ti++) {
				const entryPath = topEntries[ti]!.path;
				const isDirectory = topEntries[ti]!.isDirectory;
				const pathWithoutSlash = isDirectory ? entryPath.slice(0, -1) : entryPath;
				const displayPath = scopedQuery
					? this.#scopedPathForDisplay(scopedQuery.displayBase, pathWithoutSlash)
					: pathWithoutSlash;
				const entryName = path.basename(pathWithoutSlash);
				const completionPath = isDirectory ? `${displayPath}/` : displayPath;
				const value = buildCompletionValue(completionPath, {
					isDirectory,
					isAtPrefix: true,
					isQuotedPrefix: options.isQuotedPrefix,
				});
				suggestions.push({
					value,
					label: entryName + (isDirectory ? "/" : ""),
					description: displayPath,
				});
			}
			return suggestions;
		} catch {
			return [];
		}
	}

	async getForceFileSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		if (textBeforeCursor.trim().startsWith("/") && !textBeforeCursor.trim().includes(" ")) {
			return null;
		}

		const pathMatch = this.#extractPathPrefix(textBeforeCursor, true);
		if (pathMatch !== null) {
			const suggestions = await this.#getFileSuggestions(pathMatch);
			if (suggestions.length === 0) return null;

			return {
				items: suggestions,
				prefix: pathMatch,
			};
		}

		return null;
	}

	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		if (textBeforeCursor.trim().startsWith("/") && !textBeforeCursor.trim().includes(" ")) {
			return false;
		}

		return true;
	}

	getInlineHint(lines: string[], cursorLine: number, cursorCol: number): string | null {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		const slashStart = findLeadingSlashCommandStart(textBeforeCursor);
		if (slashStart === null) return null;

		const commandText = textBeforeCursor.slice(slashStart);
		const spaceIndex = commandText.indexOf(" ");
		if (spaceIndex === -1) return null;

		const commandName = commandText.slice(1, spaceIndex);
		const argumentText = commandText.slice(spaceIndex + 1);

		const command = this.#commands.find(cmd => commandMatchesNameOrAlias(cmd, commandName));

		if (!command || !("getInlineHint" in command) || !command.getInlineHint) {
			return null;
		}

		return command.getInlineHint(argumentText);
	}
	trySyncSlashCompletion(textBeforeCursor: string): { items: AutocompleteItem[]; prefix: string } | null {
		const slashStart = findLeadingSlashCommandStart(textBeforeCursor);
		if (slashStart === null) return null;
		const commandText = textBeforeCursor.slice(slashStart);
		if (commandText.length <= 1) return null; // Bare "/" alone, don't auto-complete
		if (commandText.includes(" ")) return null; // Only complete command name, not args

		const prefix = commandText.slice(1);
		const lowerPrefix = prefix.toLowerCase();

		const matches = buildSlashCommandCompletions(this.#commands, lowerPrefix, this.#categoryOrder);

		if (matches.length === 0) return null;
		return { items: matches, prefix: textBeforeCursor };
	}
}
