import { type } from "arktype";
import type { TruncationResult } from "../session/streaming-output";
import type { OutputMeta } from "./output-meta";

export const findSchema = type({
	"path?": type("string").describe(
		'glob, file, or directory to search — a single path or a semicolon-delimited list ("src/**/*.ts; test/**/*.ts"). Omitted -> searches the workspace root (".")',
	),
	"hidden?": type("boolean").describe("include hidden files"),
	"gitignore?": type("boolean").describe("respect gitignore"),
	"limit?": type("number").describe("max results"),
});

export type GlobToolInput = typeof findSchema.infer;

export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 200;
export const DEFAULT_GLOB_TIMEOUT_MS = 5000;

export interface GlobToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
	meta?: OutputMeta;
	scopePath?: string;
	fileCount?: number;
	files?: string[];
	truncated?: boolean;
	error?: string;
	cwd?: string;
	missingPaths?: string[];
}

export interface GlobOperations {
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	stat?: (
		absolutePath: string,
	) => Promise<{ isFile(): boolean; isDirectory(): boolean }> | { isFile(): boolean; isDirectory(): boolean };
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

export interface GlobToolOptions {
	operations?: GlobOperations;
	rootPathAlias?: boolean;
}

export interface GlobTarget {
	searchPath: string;
	globPattern: string;
	hasGlob: boolean;
}
