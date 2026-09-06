/**
 * Differential oracle: resolve-main-renderer from origin/main.
 * Source SHA: 80cf11d2f49c9535a7e4d51a38506619035b4720
 */
import type { RenderResultOptions } from "@veyyon/coding-agent/extensibility/custom-tools/types";
import type { Theme } from "@veyyon/coding-agent/theme/theme-class";
import type { Component } from "@veyyon/tui";
import { loadHistoricalOracle } from "./historical-loader";

const oracle = loadHistoricalOracle("resolve-main-renderer");

export const renderCall = oracle.renderCall as (
	args: unknown,
	options: RenderResultOptions,
	uiTheme: Theme,
) => Component;
export const renderResult = oracle.renderResult as (
	result: unknown,
	options: RenderResultOptions,
	uiTheme: Theme,
) => Component;
