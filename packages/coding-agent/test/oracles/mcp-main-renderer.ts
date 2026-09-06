/**
 * Differential oracle: mcp-main-renderer from origin/main.
 * Source SHA: 51082ac1cb086c13f8e00672dab66b4fc8042a7c
 */
import type { RenderResultOptions } from "@veyyon/coding-agent/extensibility/custom-tools/types";
import type { MCPToolDetails } from "@veyyon/coding-agent/mcp/tool-bridge";
import type { Theme } from "@veyyon/coding-agent/theme/theme-class";
import type { Component } from "@veyyon/tui";
import { loadHistoricalOracle } from "./historical-loader";

const oracle = loadHistoricalOracle("mcp-main-renderer");

export const renderMCPCall = oracle.renderMCPCall as (
	args: Record<string, unknown>,
	theme: Theme,
	label: string,
) => Component;
export const renderMCPResult = oracle.renderMCPResult as (
	result: { content: Array<{ type: string; text?: string }>; details?: MCPToolDetails; isError?: boolean },
	options: RenderResultOptions,
	theme: Theme,
	args?: Record<string, unknown>,
) => Component;
