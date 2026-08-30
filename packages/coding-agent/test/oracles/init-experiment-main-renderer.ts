/**
 * Differential oracle: init_experiment tool renderer from origin/main.
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

export interface InitExperimentRenderArgs {
	name: string;
	primary_metric?: string;
	[key: string]: unknown;
}

export interface InitExperimentRenderResult {
	content: Array<{ type: string; text?: string }>;
}

function renderInitCall(name: string, theme: Theme): string {
	return `${theme.fg("toolTitle", theme.bold("init_experiment"))} ${theme.fg("accent", truncateToWidth(replaceTabs(name), 100))}`;
}

export function renderCall(args: InitExperimentRenderArgs, _options: RenderResultOptions, theme: Theme): Component {
	return new Text(renderInitCall(args.name, theme), 0, 0);
}

export function renderResult(result: InitExperimentRenderResult): Component {
	const text = replaceTabs(result.content.find(part => part.type === "text")?.text ?? "");
	return new Text(text, 0, 0);
}
