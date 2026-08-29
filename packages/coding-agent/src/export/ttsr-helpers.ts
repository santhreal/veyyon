import * as path from "node:path";
import type { Rule } from "../capability/rule";
import type { TtsrSettings } from "../config/settings";

export type TtsrMatchSource = "text" | "thinking" | "tool";

export interface TtsrMatchContext {
	source: TtsrMatchSource;
	toolName?: string;
	filePaths?: string[];
	streamKey?: string;
}

export interface ToolScope {
	toolName?: string;
	pathGlob?: Bun.Glob;
	pathPattern?: string;
}

export interface TtsrScope {
	allowText: boolean;
	allowThinking: boolean;
	allowAnyTool: boolean;
	toolScopes: ToolScope[];
}

export interface TtsrEntry {
	rule: Rule;
	conditions: RegExp[];
	astConditions: string[];
	scope: TtsrScope;
	globalPathGlobs?: Bun.Glob[];
}

export interface InjectionRecord {
	lastInjectedAt: number;
	resetAt: number;
}

export const DEFAULT_SETTINGS: Required<TtsrSettings> = {
	enabled: true,
	contextMode: "discard",
	interruptMode: "always",
	repeatMode: "once",
	repeatGap: 10,
	builtinRules: true,
	disabledRules: [],
	experimentalRules: [],
};

export const ABSOLUTE_PATH_IN_TEXT = /\/(?:[\w.@+-]+\/)*[\w.@+-]+/g;

export function isInsideRoot(root: string, candidate: string): boolean {
	const relative = path.relative(root, path.resolve(candidate));
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export const DEFAULT_SCOPE: TtsrScope = {
	allowText: true,
	allowThinking: false,
	allowAnyTool: true,
	toolScopes: [],
};
