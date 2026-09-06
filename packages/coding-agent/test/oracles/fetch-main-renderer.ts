/**
 * Differential oracle: fetch-main-renderer from origin/main.
 * Source SHA: 80cf11d2f49c9535a7e4d51a38506619035b4720
 */
import type { RenderResultOptions } from "@veyyon/coding-agent/extensibility/custom-tools/types";
import type { Theme } from "@veyyon/coding-agent/theme/theme-class";
import type { Component } from "@veyyon/tui";
import { loadHistoricalOracle } from "./historical-loader";

const oracle = loadHistoricalOracle("fetch-main-renderer");

export const renderReadUrlCall = oracle.renderReadUrlCall as (
	args: unknown,
	options: RenderResultOptions,
	theme: Theme,
) => Component;
export const renderReadUrlResult = oracle.renderReadUrlResult as (
	result: unknown,
	options: RenderResultOptions,
	theme: Theme,
) => Component;
