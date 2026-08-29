import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { TSchema } from "@veyyon/ai";
import { Text } from "@veyyon/tui";
import { escapeRegExp, parseFrontmatter as parseOmpFrontmatter } from "@veyyon/utils";
import { type SettingPath, Settings } from "../config/settings";
import { EditTool } from "../edit";
import { formatExitCodeNotice } from "../exec/exit-notice";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateHead,
	truncateTail,
} from "../session/streaming-output";
import type { Tool, ToolSession } from "../tools";
import { BashTool } from "../tools/bash";
import { GlobTool } from "../tools/glob";
import { GrepTool } from "../tools/grep";
import { ReadTool } from "../tools/read";
import { formatBytes } from "../tools/render-utils";
import { WriteTool } from "../tools/write";
import type { ToolDefinition } from "./extensions/types";
import { LEGACY_TOOL_DEFINITION_MARKER } from "./legacy-tool-marker";
import { Type } from "./typebox";

export const LEGACY_BUILTIN_TOOL_MARKER = "__veyyonLegacyBuiltinTool";
export const LEGACY_CODING_TOOL_NAMES = ["read", "bash", "edit", "write"] as const;
export const LEGACY_READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;

export type LegacyCodingToolName = (typeof LEGACY_CODING_TOOL_NAMES)[number];
export type LegacyRegistryToolName = LegacyCodingToolName | "grep" | "glob";
export type LegacyBuiltinToolDefinition = ToolDefinition & { [LEGACY_BUILTIN_TOOL_MARKER]: true };

export type LegacySettingOverrides = Partial<Record<SettingPath, unknown>>;

export interface LegacyThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

export interface BashOperations {
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

export interface BashToolOptions {
	operations?: BashOperations;
	commandPrefix?: string;
	spawnHook?: BashSpawnHook;
}

export interface ReadToolOptions {
	autoResizeImages?: boolean;
}

export interface GrepToolOptions {
	operations?: unknown;
}

export interface FindOperations {
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

export interface FindToolOptions {
	operations?: FindOperations;
}

export interface LsOperations {
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	stat: (absolutePath: string) => Promise<{ isDirectory(): boolean }> | { isDirectory(): boolean };
	readdir: (absolutePath: string) => Promise<string[]> | string[];
}

export interface LsToolOptions {
	operations?: LsOperations;
}

export const legacyBashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
});

export const legacyReadSchema = Type.Object({
	path: Type.String({ description: "Path to read" }),
	offset: Type.Optional(Type.Number({ description: "1-based line offset" })),
	limit: Type.Optional(Type.Number({ description: "Maximum lines to read" })),
});

export const legacyGrepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search" })),
	glob: Type.Optional(Type.String({ description: "Glob filter" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
	literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string" })),
	context: Type.Optional(Type.Number({ description: "Context lines" })),
});

export const legacyFindSchema = Type.Object({
	pattern: Type.String({ description: "Glob pattern to match files" }),
	path: Type.Optional(Type.String({ description: "Directory to search" })),
	limit: Type.Optional(Type.Number({ description: "Maximum results" })),
});

export const legacyLsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list" })),
	limit: Type.Optional(Type.Number({ description: "Maximum entries" })),
});

function markToolDefinition<TParams extends TSchema, TDetails>(
	tool: ToolDefinition<TParams, TDetails>,
): ToolDefinition<TParams, TDetails> {
	Object.defineProperty(tool, LEGACY_TOOL_DEFINITION_MARKER, {
		value: true,
		enumerable: false,
		writable: false,
		configurable: true,
	});
	return tool;
}

function legacyToolSession(cwd: string, settingOverrides?: LegacySettingOverrides): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(settingOverrides),
	};
}

function createRegistryTool(
	cwd: string,
	name: LegacyRegistryToolName,
	settingOverrides?: LegacySettingOverrides,
): Tool {
	const session = legacyToolSession(cwd, settingOverrides);
	switch (name) {
		case "bash":
			return new BashTool(session);
		case "edit":
			return new EditTool(session);
		case "glob":
			return new GlobTool(session);
		case "grep":
			return new GrepTool(session);
		case "read":
			return new ReadTool(session);
		case "write":
			return new WriteTool(session);
	}
}

async function executeBuiltinTool(
	cwd: string,
	name: LegacyCodingToolName,
	toolCallId: string,
	params: unknown,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback | undefined,
) {
	const tool = createRegistryTool(cwd, name);
	return tool.execute(toolCallId, params, signal, onUpdate);
}

export function legacyBuiltinTool(cwd: string, name: LegacyCodingToolName): ToolDefinition {
	const tool = createRegistryTool(cwd, name);
	const definition: LegacyBuiltinToolDefinition = {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		hidden: tool.hidden,
		deferrable: tool.deferrable,
		approval: tool.approval,
		execute: (toolCallId, params, signal, onUpdate) =>
			executeBuiltinTool(cwd, name, toolCallId, params, signal, onUpdate),
		[LEGACY_BUILTIN_TOOL_MARKER]: true,
	};
	return markToolDefinition(definition);
}

export function stringField(value: unknown, key: string): string | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const field = Reflect.get(value, key);
	return typeof field === "string" ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const field = Reflect.get(value, key);
	return typeof field === "number" ? field : undefined;
}

export function booleanField(value: unknown, key: string): boolean | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const field = Reflect.get(value, key);
	return typeof field === "boolean" ? field : undefined;
}

function isLegacyThemeLike(value: unknown): value is LegacyThemeLike {
	if (value === null || typeof value !== "object") return false;
	return typeof Reflect.get(value, "fg") === "function" && typeof Reflect.get(value, "bold") === "function";
}

function renderTheme(second: unknown, third: unknown): LegacyThemeLike | undefined {
	if (isLegacyThemeLike(second)) return second;
	if (isLegacyThemeLike(third)) return third;
	return undefined;
}

function themedTitle(theme: LegacyThemeLike | undefined, title: string): string {
	return theme ? theme.fg("toolTitle", theme.bold(title)) : title;
}

function themedMuted(theme: LegacyThemeLike | undefined, text: string): string {
	return theme ? theme.fg("toolOutput", text) : text;
}

export function textResult(result: AgentToolResult<unknown> | undefined): string {
	return result?.content.find(block => block.type === "text")?.text ?? "";
}

function legacyRenderResult(result: AgentToolResult<unknown>, _options: unknown, themeArg: unknown): Text {
	const theme = renderTheme(themeArg, undefined);
	const output = textResult(result);
	return new Text(output ? `\n${themedMuted(theme, output)}` : "", 0, 0);
}

function lineRangePath(readPath: string, offset: number | undefined, limit: number | undefined): string {
	if (offset === undefined && limit === undefined) return readPath;
	const start = Math.max(1, Math.floor(offset ?? 1));
	if (limit === undefined) return `${readPath}:${start}`;
	const end = Math.max(start, start + Math.max(1, Math.floor(limit)) - 1);
	return `${readPath}:${start}-${end}`;
}

function joinLegacyGlob(searchPath: string, pattern: string): string {
	if (path.isAbsolute(pattern)) return pattern;
	if (!searchPath || searchPath === ".") return pattern;
	return path.join(searchPath, pattern);
}

function normalizeLegacyLimit(limit: number | undefined, fallback: number): number {
	if (limit === undefined || !Number.isFinite(limit)) return fallback;
	return Math.max(1, Math.floor(limit));
}

function appendStatus(text: string, status: string): string {
	return text ? `${text}\n\n${status}` : status;
}

function legacyBashSnapshot(output: string): { text: string; details?: { truncation: TruncationResult } } {
	const truncation = truncateTail(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!truncation.truncated) {
		return { text: truncation.content };
	}
	const startLine = truncation.totalLines - (truncation.outputLines ?? 0) + 1;
	const note =
		truncation.truncatedBy === "lines"
			? `Showing lines ${startLine}-${truncation.totalLines} of ${truncation.totalLines}`
			: `Showing lines ${startLine}-${truncation.totalLines} of ${truncation.totalLines} (${formatBytes(DEFAULT_MAX_BYTES)} limit)`;
	return {
		text: `${truncation.content}\n\n[${note}]`,
		details: { truncation },
	};
}

async function executeLegacyBashOperations(
	operations: BashOperations,
	spawn: BashSpawnContext,
	timeout: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback | undefined,
): Promise<AgentToolResult> {
	let output = "";
	const onData = (data: Buffer) => {
		output += data.toString("utf8");
		if (onUpdate) {
			const snapshot = legacyBashSnapshot(output);
			onUpdate({ content: [{ type: "text", text: snapshot.text }], details: snapshot.details });
		}
	};
	try {
		const result = await operations.exec(spawn.command, spawn.cwd, {
			onData,
			signal,
			timeout,
			env: spawn.env,
		});
		const snapshot = legacyBashSnapshot(output);
		const text = snapshot.text || "(no output)";
		if (result.exitCode !== 0 && result.exitCode !== null) {
			throw new Error(appendStatus(text, formatExitCodeNotice(result.exitCode)));
		}
		return { content: [{ type: "text", text }], details: snapshot.details };
	} catch (err) {
		const snapshot = legacyBashSnapshot(output);
		const text = snapshot.text;
		if (err instanceof Error && err.message === "aborted") {
			throw new Error(appendStatus(text, "Command aborted"));
		}
		if (err instanceof Error && err.message.startsWith("timeout:")) {
			throw new Error(appendStatus(text, `Command timed out after ${err.message.slice("timeout:".length)} seconds`));
		}
		throw err;
	}
}

export interface ParsedFrontmatter<T extends Record<string, unknown> = Record<string, unknown>> {
	frontmatter: T;
	body: string;
}

export function parseFrontmatter<T extends Record<string, unknown> = Record<string, unknown>>(
	content: string,
): ParsedFrontmatter<T> {
	const { frontmatter, body } = parseOmpFrontmatter(content, { level: "fatal" });
	return { frontmatter: frontmatter as T, body };
}

export function stripFrontmatter(content: string): string {
	return parseFrontmatter(content).body;
}

export function defineTool<TParams extends TSchema = TSchema, TDetails = unknown>(
	tool: ToolDefinition<TParams, TDetails>,
): ToolDefinition<TParams, TDetails> {
	return markToolDefinition(tool);
}

export function createReadToolDefinition(cwd: string, options?: ReadToolOptions): ToolDefinition {
	const tool = createRegistryTool(
		cwd,
		"read",
		options?.autoResizeImages === undefined ? undefined : { "images.autoResize": options.autoResizeImages },
	);
	return markToolDefinition({
		name: "read",
		label: "Read",
		description: tool.description,
		parameters: legacyReadSchema,
		approval: "read",
		renderCall: (params, options, themeArg) => {
			const theme = renderTheme(options, themeArg);
			const readPath = stringField(params, "path") ?? "";
			return new Text(`${themedTitle(theme, "read")} ${themedMuted(theme, readPath)}`, 0, 0);
		},
		renderResult: legacyRenderResult,
		execute: (toolCallId, params, signal, onUpdate) => {
			const readPath = stringField(params, "path") ?? "";
			const pathWithRange = lineRangePath(readPath, numberField(params, "offset"), numberField(params, "limit"));
			return tool.execute(toolCallId, { path: pathWithRange }, signal, onUpdate);
		},
	});
}

export function createReadTool(cwd: string, options?: ReadToolOptions): ToolDefinition {
	return createReadToolDefinition(cwd, options);
}

export function createBashToolDefinition(cwd: string, options?: BashToolOptions): ToolDefinition {
	const tool = createRegistryTool(cwd, "bash");
	return markToolDefinition({
		name: "bash",
		label: "Bash",
		description: tool.description,
		parameters: legacyBashSchema,
		approval: "exec",
		renderCall: (params, optionsArg, themeArg) => {
			const theme = renderTheme(optionsArg, themeArg);
			const command = stringField(params, "command") ?? "";
			return new Text(`${themedTitle(theme, "bash")} ${themedMuted(theme, command)}`, 0, 0);
		},
		renderResult: legacyRenderResult,
		execute: (toolCallId, params, signal, onUpdate) => {
			const rawCommand = stringField(params, "command") ?? "";
			const command = options?.commandPrefix ? `${options.commandPrefix}\n${rawCommand}` : rawCommand;
			const timeout = numberField(params, "timeout");
			const spawn = options?.spawnHook?.({ command, cwd, env: process.env });
			if (options?.operations) {
				return executeLegacyBashOperations(
					options.operations,
					{ command: spawn?.command ?? command, cwd: spawn?.cwd ?? cwd, env: spawn?.env ?? process.env },
					timeout,
					signal,
					onUpdate,
				);
			}
			return tool.execute(
				toolCallId,
				{
					command: spawn?.command ?? command,
					cwd: spawn?.cwd ?? cwd,
					env: spawn?.env,
					timeout,
				},
				signal,
				onUpdate,
			);
		},
	});
}

export function createBashTool(cwd: string, options?: BashToolOptions): ToolDefinition {
	return createBashToolDefinition(cwd, options);
}

export function createGrepToolDefinition(cwd: string, options?: GrepToolOptions): ToolDefinition {
	if (options?.operations) {
		throw new Error(
			"Legacy GrepToolOptions.operations is not supported: the built-in grep tool searches the local " +
				"filesystem natively and exposes no pluggable filesystem seam (the historical seam only customized " +
				"context-line reads; the search itself always ran locally). Register a custom grep tool via " +
				"defineTool() instead of passing operations to createGrepTool()/createGrepToolDefinition().",
		);
	}
	const tool = createRegistryTool(cwd, "grep");
	return markToolDefinition({
		name: "grep",
		label: "grep",
		description: "Search file contents for a pattern.",
		parameters: legacyGrepSchema,
		approval: "read",
		renderCall: (params, optionsArg, themeArg) => {
			const theme = renderTheme(optionsArg, themeArg);
			const pattern = stringField(params, "pattern") ?? "";
			const searchPath = stringField(params, "path") ?? ".";
			return new Text(`${themedTitle(theme, "grep")} ${themedMuted(theme, `/${pattern}/ in ${searchPath}`)}`, 0, 0);
		},
		renderResult: legacyRenderResult,
		execute: (toolCallId, params, signal, onUpdate) => {
			const rawPattern = stringField(params, "pattern") ?? "";
			const pattern = booleanField(params, "literal") ? escapeRegExp(rawPattern) : rawPattern;
			const searchPath = stringField(params, "path") ?? ".";
			const glob = stringField(params, "glob");
			const context = numberField(params, "context");
			const grepTool =
				context === undefined
					? tool
					: createRegistryTool(cwd, "grep", {
							"grep.contextBefore": Math.max(0, Math.floor(context)),
							"grep.contextAfter": Math.max(0, Math.floor(context)),
						});
			return grepTool.execute(
				toolCallId,
				{
					pattern,
					path: glob ? joinLegacyGlob(searchPath, glob) : searchPath,
					case: booleanField(params, "ignoreCase") ? false : undefined,
				},
				signal,
				onUpdate,
			);
		},
	});
}

export function createGrepTool(cwd: string, options?: GrepToolOptions): ToolDefinition {
	return createGrepToolDefinition(cwd, options);
}

export function createFindToolDefinition(cwd: string, options?: FindToolOptions): ToolDefinition {
	const tool = createRegistryTool(cwd, "glob");
	return markToolDefinition({
		name: "find",
		label: "find",
		description: "Find files by glob pattern.",
		parameters: legacyFindSchema,
		approval: "read",
		renderCall: (params, optionsArg, themeArg) => {
			const theme = renderTheme(optionsArg, themeArg);
			const pattern = stringField(params, "pattern") ?? "";
			const searchPath = stringField(params, "path") ?? ".";
			return new Text(`${themedTitle(theme, "find")} ${themedMuted(theme, `${pattern} in ${searchPath}`)}`, 0, 0);
		},
		renderResult: legacyRenderResult,
		execute: async (toolCallId, params, signal, onUpdate) => {
			const pattern = stringField(params, "pattern") ?? "*";
			const searchPath = stringField(params, "path") ?? ".";
			const limit = normalizeLegacyLimit(numberField(params, "limit"), 1000);
			const absolutePath = path.resolve(cwd, searchPath);
			if (options?.operations) {
				if (!(await options.operations.exists(absolutePath))) {
					throw new Error(`Path not found: ${absolutePath}`);
				}
				const matches = await options.operations.glob(pattern, absolutePath, {
					ignore: ["**/node_modules/**", "**/.git/**"],
					limit,
				});
				const output = matches
					.map(match => {
						const rel = path.isAbsolute(match) ? path.relative(absolutePath, match) : match;
						return rel.split(path.sep).join("/");
					})
					.join("\n");
				const truncation = truncateHead(output, { maxLines: Number.MAX_SAFE_INTEGER });
				return {
					content: [{ type: "text", text: truncation.content || "No files found matching pattern" }],
					details: truncation.truncated ? { truncation } : undefined,
				};
			}
			return tool.execute(
				toolCallId,
				{ path: joinLegacyGlob(searchPath, pattern), hidden: true, gitignore: true, limit },
				signal,
				onUpdate,
			);
		},
	});
}

export function createFindTool(cwd: string, options?: FindToolOptions): ToolDefinition {
	return createFindToolDefinition(cwd, options);
}

export function createLsToolDefinition(cwd: string, options?: LsToolOptions): ToolDefinition {
	return markToolDefinition({
		name: "ls",
		label: "ls",
		description: "List directory entries.",
		parameters: legacyLsSchema,
		approval: "read",
		renderCall: (params, optionsArg, themeArg) => {
			const theme = renderTheme(optionsArg, themeArg);
			return new Text(`${themedTitle(theme, "ls")} ${themedMuted(theme, stringField(params, "path") ?? ".")}`, 0, 0);
		},
		renderResult: legacyRenderResult,
		execute: async (_toolCallId, params, _signal, _onUpdate) => {
			const rawPath = stringField(params, "path") ?? ".";
			const limit = normalizeLegacyLimit(numberField(params, "limit"), 500);
			const absolutePath = path.resolve(cwd, rawPath);
			const ops = options?.operations;
			const exists = ops
				? await ops.exists(absolutePath)
				: await fs.stat(absolutePath).then(
						() => true,
						() => false,
					);
			if (!exists) throw new Error(`Path not found: ${absolutePath}`);
			const stat = ops ? await ops.stat(absolutePath) : await fs.stat(absolutePath);
			if (!stat.isDirectory()) {
				return { content: [{ type: "text", text: rawPath }] };
			}
			const entries = ops ? await ops.readdir(absolutePath) : await fs.readdir(absolutePath);
			const sorted = entries.slice().sort((a, b) => a.localeCompare(b));
			const limited = sorted.slice(0, limit);
			const output = limited.join("\n");
			const details = sorted.length > limited.length ? { entryLimitReached: limit } : undefined;
			const suffix = details ? `\n\n[${limit} entries limit reached]` : "";
			return { content: [{ type: "text", text: `${output}${suffix}` }], details };
		},
	});
}

export function createLsTool(cwd: string, options?: LsToolOptions): ToolDefinition {
	return createLsToolDefinition(cwd, options);
}

export type {
	AgentsFile,
	DefaultResourceLoaderOptions,
	LegacyPiCreateAgentSessionOptions,
	ResourceDiagnostic,
	ResourceLoader,
	Theme,
} from "./legacy-pi-coding-agent-shim-helpers";
// circular import: functions moved to helpers
export {
	createAgentSession,
	createCodingTools,
	createReadOnlyTools,
	DefaultResourceLoader,
	SettingsManager,
} from "./legacy-pi-coding-agent-shim-helpers";
