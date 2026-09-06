/**
 * Differential oracle: lsp-main-renderer from origin/main.
 * Source SHA: d0cb967888303de02e573bb8b0f3c5ba6fe66377
 */
import type { RenderResultOptions } from "@veyyon/coding-agent/extensibility/custom-tools/types";
import type { Theme } from "@veyyon/coding-agent/theme/theme-class";
import type { Component, Text } from "@veyyon/tui";
import { type LegacyRenderer, loadHistoricalOracle } from "./historical-loader";

const oracle = loadHistoricalOracle("lsp-main-renderer");

export const renderCall = oracle.renderCall as (
	args: unknown,
	options: RenderResultOptions,
	theme: Theme,
) => Text | Component;
export const renderResult = oracle.renderResult as (
	result: unknown,
	options: RenderResultOptions,
	theme: Theme,
) => Component;
export const lspToolRenderer = oracle.lspToolRenderer as LegacyRenderer;
