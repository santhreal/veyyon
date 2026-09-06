/**
 * Differential oracle: review-main-renderer from origin/main.
 * Source SHA: e9467ab12c976cd830eb7a61e30bfd6adc4bff1f
 */
import type { Theme } from "@veyyon/coding-agent/theme/theme-class";
import type { Component } from "@veyyon/tui";
import { loadHistoricalOracle } from "./historical-loader";

const oracle = loadHistoricalOracle("review-main-renderer");

export type FindingPriority = "P0" | "P1" | "P2" | "P3";

export interface ReviewRenderArgs {
	priority: FindingPriority;
	title: string;
}

export interface ReviewRenderDetails {
	title: string;
	priority: FindingPriority;
	file_path: string;
	line_start: number;
	line_end: number;
}

export interface ReviewRenderResult {
	content: Array<{ type: string; text?: string }>;
	details?: ReviewRenderDetails;
}

export const renderCall = oracle.renderCall as (args: ReviewRenderArgs, theme: Theme) => Component;
export const renderResult = oracle.renderResult as (result: ReviewRenderResult, theme: Theme) => Component;
