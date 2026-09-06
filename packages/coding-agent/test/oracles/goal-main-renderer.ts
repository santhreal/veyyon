/**
 * Differential oracle: goal-main-renderer from origin/main.
 * Source SHA: e9467ab12c976cd830eb7a61e30bfd6adc4bff1f
 */
import type { RenderResultOptions } from "@veyyon/coding-agent/extensibility/custom-tools/types";
import type { Theme } from "@veyyon/coding-agent/theme/theme-class";
import type { Component } from "@veyyon/tui";
import { loadHistoricalOracle } from "./historical-loader";

const oracle = loadHistoricalOracle("goal-main-renderer");

export interface GoalRenderArgs {
	op?: "create" | "get" | "complete" | "resume" | "drop";
	objective?: string;
}

export interface GoalRenderResult {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
}

export const renderCall = oracle.renderCall as (
	args: GoalRenderArgs,
	options: RenderResultOptions,
	uiTheme: Theme,
) => Component;
export const renderResult = oracle.renderResult as (
	result: GoalRenderResult,
	options: RenderResultOptions,
	uiTheme: Theme,
	args?: GoalRenderArgs,
) => Component;
