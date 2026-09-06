/**
 * Differential oracle: log-experiment-main-renderer from origin/main.
 * Source SHA: e9467ab12c976cd830eb7a61e30bfd6adc4bff1f
 */
import type { RenderResultOptions } from "@veyyon/coding-agent/extensibility/custom-tools/types";
import type { Theme } from "@veyyon/coding-agent/theme/theme-class";
import type { Component } from "@veyyon/tui";
import { loadHistoricalOracle } from "./historical-loader";

const oracle = loadHistoricalOracle("log-experiment-main-renderer");

export interface LogExperimentRenderArgs {
	metric: number;
	status: "keep" | "discard" | "crash" | "checks_failed";
	description: string;
	metrics?: Record<string, number>;
	asi?: Record<string, unknown>;
	commit?: string;
	justification?: string;
	flag_runs?: Array<{ run_id: number; reason: string }>;
}

export interface LogExperimentRenderResult {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
}

export const renderCall = oracle.renderCall as (
	args: LogExperimentRenderArgs,
	options: RenderResultOptions,
	theme: Theme,
) => Component;
export const renderResult = oracle.renderResult as (
	result: LogExperimentRenderResult,
	options: RenderResultOptions,
	theme: Theme,
) => Component;
