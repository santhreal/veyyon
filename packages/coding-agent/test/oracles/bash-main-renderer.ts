/**
 * Differential oracle: bash-main-renderer from origin/main.
 * Source SHA: d0cb967888303de02e573bb8b0f3c5ba6fe66377
 */
import type { RenderResultOptions } from "@veyyon/coding-agent/extensibility/custom-tools/types";
import type { Theme } from "@veyyon/coding-agent/theme/theme-class";
import { type LegacyRenderer, loadHistoricalOracle } from "./historical-loader";

const oracle = loadHistoricalOracle("bash-main-renderer");

export interface BashRenderArgs {
	command?: string;
	env?: Record<string, string>;
	timeout?: number;
	cwd?: string;
	__partialJson?: string;
	[key: string]: unknown;
}

export interface BashRenderContext {
	/** Raw output text */
	output?: string;
	/** Whether output came from artifact storage */
	isFullOutput?: boolean;
	/** Whether output is expanded */
	expanded?: boolean;
	/** Number of preview lines when collapsed */
	previewLines?: number;
	/** Timeout in seconds */
	timeout?: number;
}

export interface ShellRendererConfig<TArgs = BashRenderArgs> {
	resolveTitle: (args: TArgs | undefined, options: RenderResultOptions) => string;
	resolveCommand?: (args: TArgs | undefined) => string | undefined;
	resolveCwd?: (args: TArgs | undefined) => string | undefined;
	resolveEnv?: (args: TArgs | undefined) => Record<string, string> | undefined;
	showHeader?: boolean;
}

export const getBashEnvForDisplay = oracle.getBashEnvForDisplay as (
	args: BashRenderArgs,
) => Record<string, string> | undefined;
export const formatBashCommandLines = oracle.formatBashCommandLines as (
	args: BashRenderArgs,
	uiTheme: Theme,
) => string[];
export const createShellRenderer = oracle.createShellRenderer as <TArgs = BashRenderArgs>(
	config: ShellRendererConfig<TArgs>,
) => LegacyRenderer;
export const bashMainRenderer = oracle.bashMainRenderer as LegacyRenderer;
