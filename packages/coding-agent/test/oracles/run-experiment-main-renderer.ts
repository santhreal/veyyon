/**
 * Differential oracle: run-experiment-main-renderer from origin/main.
 * Source SHA: e9467ab12c976cd830eb7a61e30bfd6adc4bff1f
 */
import type { RenderResultOptions } from "@veyyon/coding-agent/extensibility/custom-tools/types";
import type { Theme } from "@veyyon/coding-agent/theme/theme-class";
import type { Component } from "@veyyon/tui";
import { loadHistoricalOracle } from "./historical-loader";

const oracle = loadHistoricalOracle("run-experiment-main-renderer");

export interface RunExperimentRenderArgs {}

export interface RunExperimentRenderResult {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
}

export const renderCall = oracle.renderCall as (
	args: RunExperimentRenderArgs,
	options: RenderResultOptions,
	theme: Theme,
) => Component;
export const renderResult = oracle.renderResult as (
	result: RunExperimentRenderResult,
	options: RenderResultOptions,
	theme: Theme,
) => Component;
