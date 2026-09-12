/**
 * Shared helpers and base utilities for command controllers (/mcp, /ssh, /todo, /goal).
 *
 * Consolidates subcommand parsing, routing, source grouping, and transcript block presentation.
 */
import { Markdown } from "@veyyon/tui";
import type { SourceMeta } from "../../../discovery/capability/types";
import { getMarkdownTheme } from "../../../theme/markdown-theme";
import { theme } from "../../../theme/theme";
import { shortenPath } from "../../../tools/core/render-utils";
import { COMPOSER_INSET_COLS } from "../components/composer/composer-chrome";
import { mountTranscriptBlock, transcriptBlockText } from "../components/transcript/transcript-block-chrome";
import { TranscriptBlock } from "../components/transcript/transcript-container";
import type { InteractiveModeContext } from "../types";

export interface SubcommandRouteDef {
	name: string;
	aliases?: string[];
	handler: (argsText: string, fullText: string, parts: string[]) => void | Promise<void>;
}

export interface SubcommandDispatchOptions {
	onHelp: () => void;
	showError: (message: string) => void;
}

/**
 * Parse and dispatch a command string to its registered subcommands.
 * Checks for missing subcommand or 'help' and routes to `onHelp`.
 * Dispatches to matching handler by name or alias, or shows an unknown subcommand error.
 */
export async function dispatchSubcommand(
	text: string,
	commandName: string,
	routes: readonly SubcommandRouteDef[],
	options: SubcommandDispatchOptions,
): Promise<void> {
	const parts = text.trim().split(/\s+/);
	const subcommand = parts[1]?.toLowerCase();

	if (!subcommand || subcommand === "help") {
		options.onHelp();
		return;
	}

	for (const route of routes) {
		if (route.name === subcommand || route.aliases?.includes(subcommand)) {
			const prefixMatch = text.match(new RegExp(`^\\/${commandName}\\s+${subcommand}\\b\\s*(.*)$`, "i"));
			const argsText = prefixMatch?.[1]?.trim() ?? "";
			await route.handler(argsText, text, parts);
			return;
		}
	}

	options.showError(`Unknown subcommand: ${subcommand}. Type /${commandName} help for usage.`);
}

/**
 * Present a formatted Markdown panel on the transcript rail.
 */
export function showMarkdownPanel(ctx: Pick<InteractiveModeContext, "present">, title: string, markdown: string): void {
	const block = new TranscriptBlock();
	mountTranscriptBlock(block, {
		header: theme.bold(theme.fg("accent", title)),
		body: new Markdown(markdown.trim(), COMPOSER_INSET_COLS, 0, getMarkdownTheme()),
	});
	ctx.present(block);
}

/**
 * Present a plain message block on the transcript rail.
 */
export function showCommandMessage(ctx: Pick<InteractiveModeContext, "present">, text: string): void {
	const block = new TranscriptBlock();
	mountTranscriptBlock(block, { body: transcriptBlockText(text) });
	ctx.present(block);
}

/**
 * Group capability-loaded items by their source provider+path, yielding each
 * group with a display-ready `shortPath`.
 */
export function* groupBySource<T>(
	items: Iterable<T>,
	getSource: (item: T) => SourceMeta,
): Iterable<{ providerName: string; shortPath: string; items: T[] }> {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const src = getSource(item);
		const key = `${src.providerName}|${src.path}`;
		let group = groups.get(key);
		if (!group) {
			group = [];
			groups.set(key, group);
		}
		group.push(item);
	}
	for (const [key, grouped] of groups) {
		const sepIdx = key.indexOf("|");
		yield {
			providerName: key.slice(0, sepIdx),
			shortPath: shortenPath(key.slice(sepIdx + 1)),
			items: grouped,
		};
	}
}
