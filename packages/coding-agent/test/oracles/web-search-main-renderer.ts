/**
 * Differential oracle: web-search-main-renderer from origin/main.
 * Source SHA: d0cb967888303de02e573bb8b0f3c5ba6fe66377
 */
import type { RenderResultOptions } from "@veyyon/coding-agent/extensibility/custom-tools/types";
import type { Theme } from "@veyyon/coding-agent/theme/theme-class";
import type { Component } from "@veyyon/tui";
import { type LegacyRenderer, loadHistoricalOracle } from "./historical-loader";

const oracle = loadHistoricalOracle("web-search-main-renderer");

export interface SearchRenderDetails {
	response?: unknown;
	error?: string;
}

export const renderSearchResult = oracle.renderSearchResult as (
	result: unknown,
	options: RenderResultOptions,
	theme: Theme,
	args?: unknown,
) => Component;
export const renderSearchCall = oracle.renderSearchCall as (
	args: unknown,
	options: RenderResultOptions,
	theme: Theme,
) => Component;
export const webSearchToolRenderer = oracle.webSearchToolRenderer as LegacyRenderer;
