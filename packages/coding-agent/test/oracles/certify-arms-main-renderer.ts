/**
 * Differential oracle: certify-arms-main-renderer from origin/main.
 * Source SHA: e9467ab12c976cd830eb7a61e30bfd6adc4bff1f
 */
import type { RenderResultOptions } from "@veyyon/coding-agent/extensibility/custom-tools/types";
import type { Theme } from "@veyyon/coding-agent/theme/theme-class";
import type { Component } from "@veyyon/tui";
import { loadHistoricalOracle } from "./historical-loader";

const oracle = loadHistoricalOracle("certify-arms-main-renderer");

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

export const renderCall = oracle.renderCall as (
	args: CertifyArmsRenderArgs,
	options: RenderResultOptions,
	theme: Theme,
) => Component;
export const renderResult = oracle.renderResult as (
	result: CertifyArmsRenderResult,
	options: RenderResultOptions,
	theme: Theme,
) => Component;
