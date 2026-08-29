import type { AutocompleteItem, SlashCommand } from "@veyyon/tui";
import type { KeybindingsManager } from "../config/keybindings";
import type { Skill } from "../extensibility/skills";
import { getGithubRefContext } from "./github-ref-autocomplete";
import { applyInternalUrlCompletion } from "./internal-url-autocomplete";

export interface PromptActionDefinition {
	id: string;
	label: string;
	description: string;
	keywords: string[];
	execute: (prefix: string) => void;
}

export interface PromptActionAutocompleteItem extends AutocompleteItem {
	actionId: string;
	execute: (prefix: string) => void;
}

export interface PromptActionAutocompleteOptions {
	commands: SlashCommand[];
	basePath: string;
	skills?: readonly Skill[];
	keybindings: KeybindingsManager;
	copyCurrentLine: () => void;
	copyPrompt: () => void;
	undo: (prefix: string) => void;
	moveCursorToMessageEnd: () => void;
	moveCursorToMessageStart: () => void;
	moveCursorToLineStart: () => void;
	moveCursorToLineEnd: () => void;
}

export function isPromptActionItem(item: AutocompleteItem): item is PromptActionAutocompleteItem {
	return "actionId" in item && "execute" in item && typeof item.execute === "function";
}

export function getPromptActionPrefix(textBeforeCursor: string): string | null {
	const hashIndex = textBeforeCursor.lastIndexOf("#");
	if (hashIndex === -1) return null;

	const query = textBeforeCursor.slice(hashIndex + 1);
	if (/[\s]/.test(query)) {
		return null;
	}

	return textBeforeCursor.slice(hashIndex);
}

export function applyGithubRefCompletion(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	item: AutocompleteItem,
	prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } | null {
	if (!getGithubRefContext(prefix)) return null;
	const scheme: "pr" | "issue" | null = item.value.startsWith("pr://")
		? "pr"
		: item.value.startsWith("issue://")
			? "issue"
			: null;
	if (!scheme) return { lines, cursorLine, cursorCol };

	const currentLine = lines[cursorLine] || "";
	const liveContext = getGithubRefContext(currentLine.slice(0, cursorCol));
	if (!liveContext || (liveContext.qualifier && liveContext.qualifier !== scheme)) {
		return { lines, cursorLine, cursorCol };
	}

	return applyInternalUrlCompletion(
		lines,
		cursorLine,
		cursorCol,
		{ ...item, value: `${scheme}://${liveContext.number}` },
		liveContext.prefix,
	);
}
