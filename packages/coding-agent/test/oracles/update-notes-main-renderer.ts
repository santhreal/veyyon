/**
 * Differential oracle: update_notes tool renderer from origin/main.
 *
 * Source SHA: e9467ab12c976cd830eb7a61e30bfd6adc4bff1f
 * Frozen: never edited to make a test pass.
 */

import type { RenderResultOptions } from "@veyyon/coding-agent/extensibility/custom-tools/types";
import type { Theme } from "@veyyon/coding-agent/theme/theme";
import type { Component } from "@veyyon/tui";
import { Text } from "@veyyon/tui";
import { truncateToWidth } from "@veyyon/utils/width";
import { replaceTabs } from "@veyyon/utils/wrap";

export interface UpdateNotesRenderArgs {
	body: string;
	append_idea?: string;
}

export interface UpdateNotesRenderResult {
	content: Array<{ type: string; text?: string }>;
}

export function renderCall(args: UpdateNotesRenderArgs, _options: RenderResultOptions, theme: Theme): Component {
	const preview = args.append_idea ?? args.body.slice(0, 100);
	return new Text(
		`${theme.fg("toolTitle", theme.bold("update_notes"))} ${theme.fg("muted", truncateToWidth(replaceTabs(preview), 100))}`,
		0,
		0,
	);
}

export function renderResult(result: UpdateNotesRenderResult, _options: RenderResultOptions, theme: Theme): Component {
	const text = replaceTabs(result.content.find(part => part.type === "text")?.text ?? "");
	return new Text(theme.fg("muted", text), 0, 0);
}
