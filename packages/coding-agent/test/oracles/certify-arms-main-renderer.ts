/**
 * Differential oracle: certify_arms tool renderer from origin/main.
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

export interface CertifyArmsRenderArgs {
	arms: Array<{
		arm: string;
		hypothesis: string;
		diff: string;
		modified_paths: string[];
		metric?: number;
		cold_metric?: number;
	}>;
	verdicts?: Array<{
		arm: string;
		certified_by: string;
		flagged: boolean;
		reason?: string;
	}>;
	baseline_cold_metric?: number;
}

export interface CertifyArmsRenderResult {
	content: Array<{ type: string; text?: string }>;
}

export function renderCall(args: CertifyArmsRenderArgs, _options: RenderResultOptions, theme: Theme): Component {
	const summary =
		args.verdicts === undefined ? `triage ${args.arms.length} arms` : `verdicts for ${args.verdicts.length} arms`;
	return new Text(
		`${theme.fg("toolTitle", theme.bold("certify_arms"))} ${theme.fg("muted", truncateToWidth(replaceTabs(summary), 100))}`,
		0,
		0,
	);
}

export function renderResult(result: CertifyArmsRenderResult, _options: RenderResultOptions, theme: Theme): Component {
	const text = replaceTabs(result.content.find(part => part.type === "text")?.text ?? "");
	return new Text(theme.fg("muted", text), 0, 0);
}
