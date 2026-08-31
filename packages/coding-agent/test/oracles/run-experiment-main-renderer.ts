/**
 * Differential oracle: run_experiment tool renderer from origin/main.
 *
 * Source SHA: e9467ab12c976cd830eb7a61e30bfd6adc4bff1f
 * Frozen: never edited to make a test pass.
 */

import { formatNum } from "@veyyon/coding-agent/autoresearch/helpers";
import { DEFAULT_HARNESS_COMMAND } from "@veyyon/coding-agent/autoresearch/tools/init-experiment";
import type { RunDetails, RunExperimentProgressDetails } from "@veyyon/coding-agent/autoresearch/types";
import type { RenderResultOptions } from "@veyyon/coding-agent/extensibility/custom-tools/types";
import type { Theme } from "@veyyon/coding-agent/theme/theme";
import { shortenPath } from "@veyyon/coding-agent/tools/core/render-utils";
import type { Component } from "@veyyon/tui";
import { Text } from "@veyyon/tui";
import { replaceTabs } from "@veyyon/utils/wrap";

export interface RunExperimentRenderArgs {}

export interface RunExperimentRenderResult {
	content: Array<{ type: string; text?: string }>;
	details?: RunDetails | RunExperimentProgressDetails;
}

function renderStatus(details: RunDetails, theme: Theme): string {
	if (details.timedOut) {
		return theme.fg("error", `TIMEOUT ${details.durationSeconds.toFixed(1)}s`);
	}
	if (details.exitCode !== 0) {
		return theme.fg("error", `FAIL exit=${details.exitCode} ${details.durationSeconds.toFixed(1)}s`);
	}
	const metric =
		details.parsedPrimary !== null
			? ` ${details.metricName}=${formatNum(details.parsedPrimary, details.metricUnit)}`
			: "";
	return theme.fg("success", `PASS ${details.durationSeconds.toFixed(1)}s${metric}`);
}

function isRunDetails(value: unknown): value is RunDetails {
	if (value && typeof value === "object") {
		return "command" in value && "durationSeconds" in value;
	}
	return false;
}

function isProgressDetails(value: unknown): value is RunExperimentProgressDetails {
	if (value && typeof value === "object" && "phase" in value) {
		return value.phase === "running";
	}
	return false;
}

export function renderCall(_args: RunExperimentRenderArgs, _options: RenderResultOptions, theme: Theme): Component {
	return new Text(
		`${theme.fg("toolTitle", theme.bold("run_experiment"))} ${theme.fg("muted", DEFAULT_HARNESS_COMMAND)}`,
		0,
		0,
	);
}

export function renderResult(result: RunExperimentRenderResult, options: RenderResultOptions, theme: Theme): Component {
	if (isProgressDetails(result.details)) {
		const header = theme.fg("warning", `Running ${result.details.elapsed}...`);
		const preview = replaceTabs(result.content.find(part => part.type === "text")?.text ?? "");
		return new Text(preview ? `${header}\n${theme.fg("dim", preview)}` : header, 0, 0);
	}
	const details = result.details;
	if (!details || !isRunDetails(details)) {
		return new Text(replaceTabs(result.content.find(part => part.type === "text")?.text ?? ""), 0, 0);
	}
	const statusText = renderStatus(details, theme);
	if (!options.expanded && details.tailOutput.trim().length === 0) {
		return new Text(statusText, 0, 0);
	}
	const preview = replaceTabs(
		options.expanded ? details.tailOutput : details.tailOutput.split("\n").slice(-5).join("\n"),
	);
	const suffix =
		options.expanded && details.truncation && details.fullOutputPath
			? `\n${theme.fg("warning", `Full output: ${shortenPath(details.fullOutputPath)}`)}`
			: "";
	return new Text(preview ? `${statusText}\n${theme.fg("dim", preview)}${suffix}` : statusText, 0, 0);
}
