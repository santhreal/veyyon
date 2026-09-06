/**
 * Differential oracle: task-main-renderer from origin/main.
 * Source SHA: c0039837474b2587b818a346b7ff870ce9a0c0e7
 */
import type { Theme } from "@veyyon/coding-agent/theme/theme-class";
import type { Component } from "@veyyon/tui";
import { loadHistoricalOracle } from "./historical-loader";

const oracle = loadHistoricalOracle("task-main-renderer");

export const formatTaskId = oracle.formatTaskId as (id: string) => string;
export const renderCall = oracle.renderCall as (args: unknown, options: unknown, theme: Theme) => Component;
export const renderResult = oracle.renderResult as (
	result: unknown,
	options: unknown,
	theme: Theme,
	args?: unknown,
) => Component;
