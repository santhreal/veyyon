import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { TSchema } from "@veyyon/ai";
import { Text } from "@veyyon/tui";
import {
	errorMessage,
	escapeRegExp,
	getAgentDir,
	getProjectDir,
	parseFrontmatter as parseOmpFrontmatter,
} from "@veyyon/utils";
import type { PromptTemplate } from "../config/prompt-templates";
import { type SettingPath, Settings } from "../config/settings";
import { EditTool } from "../edit";
import { formatExitCodeNotice } from "../exec/exit-notice";
import type { CreateAgentSessionOptions, CreateAgentSessionResult, LoadExtensionsResult } from "../sdk";
import {
	discoverContextFiles,
	discoverPromptTemplates,
	discoverSessionExtensionPaths,
	discoverSkills,
	createAgentSession as ompCreateAgentSession,
} from "../sdk";
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
import { EventBus } from "../utils/event-bus";
import { loadExtensionFromFactory, loadExtensions } from "./extensions";
import { ExtensionRuntime } from "./extensions/loader";
import type { ExtensionFactory, ToolDefinition } from "./extensions/types";
import { LEGACY_TOOL_DEFINITION_MARKER } from "./legacy-tool-marker";
import type { Skill } from "./skills";
import { loadSkillsFromDir } from "./skills";
import { Type } from "./typebox";

const LEGACY_BUILTIN_TOOL_MARKER = "__veyyonLegacyBuiltinTool";
const LEGACY_CODING_TOOL_NAMES = ["read", "bash", "edit", "write"] as const;
const LEGACY_READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;

type LegacyCodingToolName = (typeof LEGACY_CODING_TOOL_NAMES)[number];
type LegacyRegistryToolName = LegacyCodingToolName | "grep" | "glob";
type LegacyBuiltinToolDefinition = ToolDefinition & { [LEGACY_BUILTIN_TOOL_MARKER]: true };

type LegacySettingOverrides = Partial<Record<SettingPath, unknown>>;

interface LegacyThemeLike {
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

const legacyBashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
});

const legacyReadSchema = Type.Object({
	path: Type.String({ description: "Path to read" }),
	offset: Type.Optional(Type.Number({ description: "1-based line offset" })),
	limit: Type.Optional(Type.Number({ description: "Maximum lines to read" })),
});

const legacyGrepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search" })),
	glob: Type.Optional(Type.String({ description: "Glob filter" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
	literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string" })),
	context: Type.Optional(Type.Number({ description: "Context lines" })),
});

const legacyFindSchema = Type.Object({
	pattern: Type.String({ description: "Glob pattern to match files" }),
	path: Type.Optional(Type.String({ description: "Directory to search" })),
	limit: Type.Optional(Type.Number({ description: "Maximum results" })),
});

const legacyLsSchema = Type.Object({
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

function legacyBuiltinTool(cwd: string, name: LegacyCodingToolName): ToolDefinition {
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

function stringField(value: unknown, key: string): string | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const field = Reflect.get(value, key);
	return typeof field === "string" ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const field = Reflect.get(value, key);
	return typeof field === "number" ? field : undefined;
}

function booleanField(value: unknown, key: string): boolean | undefined {
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

function textResult(result: AgentToolResult<unknown> | undefined): string {
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

export function createCodingTools(cwd: string): ToolDefinition[] {
	return LEGACY_CODING_TOOL_NAMES.map(name => legacyBuiltinTool(cwd, name));
}

export function createReadOnlyTools(cwd: string): ToolDefinition[] {
	return LEGACY_READ_ONLY_TOOL_NAMES.map(name => {
		if (name === "read") return createReadTool(cwd);
		if (name === "grep") return createGrepTool(cwd);
		if (name === "find") return createFindTool(cwd);
		return createLsTool(cwd);
	});
}

export const SettingsManager = {
	create(cwd: string, agentDir?: string): Promise<Settings> {
		return Settings.init({ cwd, agentDir });
	},

	inMemory(): Settings {
		return Settings.isolated();
	},
} as const;

export type ResourceDiagnostic = {
	type: "error" | "warning" | "info";
	message: string;
	path?: string;
};

export interface AgentsFile {
	path: string;
	content: string;
}

export interface Theme {
	name: string;
}

export interface DefaultResourceLoaderOptions {
	cwd?: string;
	agentDir?: string;
	settingsManager?: Settings | Promise<Settings>;
	eventBus?: EventBus;
	additionalExtensionPaths?: string[];
	additionalSkillPaths?: string[];
	additionalPromptTemplatePaths?: string[];
	additionalThemePaths?: string[];
	extensionFactories?: ExtensionFactory[];
	noExtensions?: boolean;
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noThemes?: boolean;
	noContextFiles?: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string | string[];
	extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	};
	agentsFilesOverride?: (base: { agentsFiles: AgentsFile[] }) => { agentsFiles: AgentsFile[] };
	systemPromptOverride?: (base: string | undefined) => string | undefined;
	appendSystemPromptOverride?: (base: string[]) => string[];
}

export interface ResourceLoader {
	getExtensions(): LoadExtensionsResult;
	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
	getAgentsFiles(): { agentsFiles: AgentsFile[] };
	getSystemPrompt(): string | undefined;
	getAppendSystemPrompt(): string[];
	reload(): Promise<void>;
	readonly __veyyonLegacyPiLoader?: true;
}

interface ResolvedLoaderState {
	cwd: string;
	agentDir: string;
	settingsPromise?: Promise<Settings>;
	eventBus: EventBus;
	extensionFactories: ExtensionFactory[];
	noExtensions: boolean;
	additionalExtensionPaths: string[];
	additionalSkillPaths: string[];
	additionalPromptTemplatePaths: string[];
}

interface AdditionalSkillLoadResult {
	skills: Skill[];
	diagnostics: ResourceDiagnostic[];
}

interface AdditionalPromptLoadResult {
	prompts: PromptTemplate[];
	diagnostics: ResourceDiagnostic[];
}

export class DefaultResourceLoader implements ResourceLoader {
	readonly __veyyonLegacyPiLoader = true as const;
	#state: ResolvedLoaderState;
	#options: DefaultResourceLoaderOptions;
	#extensionsResult: LoadExtensionsResult = {
		extensions: [],
		errors: [],
		withheld: [],
		runtime: new ExtensionRuntime(),
	};
	#skills: Skill[] = [];
	#skillDiagnostics: ResourceDiagnostic[] = [];
	#prompts: PromptTemplate[] = [];
	#promptDiagnostics: ResourceDiagnostic[] = [];
	#themes: Theme[] = [];
	#themeDiagnostics: ResourceDiagnostic[] = [];
	#agentsFiles: AgentsFile[] = [];
	#systemPrompt: string | undefined;
	#appendSystemPrompt: string[] = [];
	#loaded = false;

	constructor(options: DefaultResourceLoaderOptions = {}) {
		this.#options = options;
		const cwd = options.cwd ?? getProjectDir();
		const agentDir = options.agentDir ?? getAgentDir();
		this.#state = {
			cwd,
			agentDir,
			settingsPromise: options.settingsManager ? Promise.resolve(options.settingsManager) : undefined,
			eventBus: options.eventBus ?? new EventBus(),
			extensionFactories: options.extensionFactories ?? [],
			noExtensions: options.noExtensions ?? false,
			additionalExtensionPaths: options.additionalExtensionPaths ?? [],
			additionalSkillPaths: options.additionalSkillPaths ?? [],
			additionalPromptTemplatePaths: options.additionalPromptTemplatePaths ?? [],
		};
	}

	getExtensions(): LoadExtensionsResult {
		return this.#extensionsResult;
	}

	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
		return { skills: this.#skills, diagnostics: this.#skillDiagnostics };
	}

	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		return { prompts: this.#prompts, diagnostics: this.#promptDiagnostics };
	}

	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
		return { themes: this.#themes, diagnostics: this.#themeDiagnostics };
	}

	getAgentsFiles(): { agentsFiles: AgentsFile[] } {
		return { agentsFiles: this.#agentsFiles };
	}

	getSystemPrompt(): string | undefined {
		return this.#systemPrompt;
	}

	getAppendSystemPrompt(): string[] {
		return this.#appendSystemPrompt;
	}

	async reload(): Promise<void> {
		const { cwd, agentDir } = this.#state;
		const options = this.#options;

		let settingsPromise = this.#state.settingsPromise;
		if (!settingsPromise) {
			settingsPromise = Settings.init({ cwd, agentDir });
			this.#state.settingsPromise = settingsPromise;
		}
		const settings = await settingsPromise;

		const [extensionsResult, skillsBase, additionalSkills, prompts, additionalPrompts, agentsFiles] =
			await Promise.all([
				this.#loadExtensions(settings),
				options.noSkills
					? Promise.resolve({ skills: [], warnings: [] })
					: discoverSkills(cwd, agentDir, {
							...settings.getGroup("skills"),
							disabledExtensions: settings.get("disabledExtensions") ?? [],
						}),
				this.#loadAdditionalSkills(),
				options.noPromptTemplates ? Promise.resolve([]) : discoverPromptTemplates(cwd, agentDir),
				this.#loadAdditionalPromptTemplates(),
				options.noContextFiles ? Promise.resolve([]) : discoverContextFiles(cwd, agentDir),
			]);

		this.#extensionsResult = options.extensionsOverride
			? options.extensionsOverride(extensionsResult)
			: extensionsResult;

		const skillsBaseResult = {
			skills: [...skillsBase.skills, ...additionalSkills.skills],
			diagnostics: [
				...skillsBase.warnings.map(w => ({
					type: "warning" as const,
					message: w.message,
					path: w.skillPath,
				})),
				...additionalSkills.diagnostics,
			],
		};
		const skillsFinal = options.skillsOverride ? options.skillsOverride(skillsBaseResult) : skillsBaseResult;
		this.#skills = skillsFinal.skills;
		this.#skillDiagnostics = skillsFinal.diagnostics;

		const promptsBase = {
			prompts: [...prompts, ...additionalPrompts.prompts],
			diagnostics: additionalPrompts.diagnostics,
		};
		const promptsFinal = options.promptsOverride ? options.promptsOverride(promptsBase) : promptsBase;
		this.#prompts = promptsFinal.prompts;
		this.#promptDiagnostics = promptsFinal.diagnostics;

		const themesBase = { themes: [] as Theme[], diagnostics: [] as ResourceDiagnostic[] };
		const themesFinal = options.themesOverride ? options.themesOverride(themesBase) : themesBase;
		this.#themes = themesFinal.themes;
		this.#themeDiagnostics = themesFinal.diagnostics;

		const agentsFilesBase = { agentsFiles };
		const agentsFilesFinal = options.agentsFilesOverride
			? options.agentsFilesOverride(agentsFilesBase)
			: agentsFilesBase;
		this.#agentsFiles = agentsFilesFinal.agentsFiles;

		const baseSystemPrompt = options.systemPrompt;
		this.#systemPrompt = options.systemPromptOverride
			? options.systemPromptOverride(baseSystemPrompt)
			: baseSystemPrompt;

		const appendSource = options.appendSystemPrompt;
		const baseAppend =
			typeof appendSource === "string" ? [appendSource] : Array.isArray(appendSource) ? appendSource : [];
		this.#appendSystemPrompt = options.appendSystemPromptOverride
			? options.appendSystemPromptOverride(baseAppend)
			: baseAppend;

		this.#loaded = true;
	}

	async #loadExtensions(settings: Settings): Promise<LoadExtensionsResult> {
		const { cwd, agentDir, noExtensions, additionalExtensionPaths, extensionFactories, eventBus } = this.#state;

		if (noExtensions && additionalExtensionPaths.length === 0 && extensionFactories.length === 0) {
			return { extensions: [], errors: [], withheld: [], runtime: new ExtensionRuntime() };
		}

		const paths = await discoverSessionExtensionPaths(
			{
				disableExtensionDiscovery: noExtensions,
				additionalExtensionPaths,
			},
			cwd,
			settings,
			agentDir,
		);

		const result = await loadExtensions(paths, cwd, eventBus, undefined, {
			agentDir,
			configuredPaths: [...additionalExtensionPaths, ...(settings.get("extensions") ?? [])],
		});
		for (let i = 0; i < extensionFactories.length; i++) {
			const loaded = await loadExtensionFromFactory(
				extensionFactories[i],
				cwd,
				eventBus,
				result.runtime,
				`<inline-loader-${i}>`,
			);
			result.extensions.push(loaded);
		}
		return result;
	}

	async #loadAdditionalSkills(): Promise<AdditionalSkillLoadResult> {
		const skills: Skill[] = [];
		const diagnostics: ResourceDiagnostic[] = [];

		for (const resourcePath of this.#state.additionalSkillPaths) {
			const resolvedPath = path.isAbsolute(resourcePath)
				? resourcePath
				: path.resolve(this.#state.cwd, resourcePath);
			const skillDir =
				path.basename(resolvedPath).toLowerCase() === "skill.md" ? path.dirname(resolvedPath) : resolvedPath;
			try {
				const result = await loadSkillsFromDir({
					dir: skillDir,
					source: "legacy-resource-loader",
				});
				for (let si = 0; si < result.skills.length; si++) skills.push(result.skills[si]!);
				diagnostics.push(
					...result.warnings.map(w => ({
						type: "warning" as const,
						message: w.message,
						path: w.skillPath,
					})),
				);
			} catch (err) {
				diagnostics.push({
					type: "warning",
					message: `Failed to load additional skill path: ${errorMessage(err)}`,
					path: resolvedPath,
				});
			}
		}

		return { skills, diagnostics };
	}

	async #loadAdditionalPromptTemplates(): Promise<AdditionalPromptLoadResult> {
		const prompts: PromptTemplate[] = [];
		const diagnostics: ResourceDiagnostic[] = [];

		for (const resourcePath of this.#state.additionalPromptTemplatePaths) {
			const resolvedPath = path.isAbsolute(resourcePath)
				? resourcePath
				: path.resolve(this.#state.cwd, resourcePath);
			const files: string[] = [];
			try {
				const stat = await fs.stat(resolvedPath);
				if (stat.isDirectory()) {
					const glob = new Bun.Glob("**/*.md");
					for await (const entry of glob.scan({ cwd: resolvedPath, absolute: false, onlyFiles: true })) {
						files.push(path.join(resolvedPath, entry));
					}
					files.sort();
				} else if (resolvedPath.toLowerCase().endsWith(".md")) {
					files.push(resolvedPath);
				} else {
					diagnostics.push({
						type: "warning",
						message: "Additional prompt template path is neither a directory nor a Markdown file",
						path: resolvedPath,
					});
				}
			} catch (err) {
				diagnostics.push({
					type: "warning",
					message: `Failed to inspect additional prompt template path: ${errorMessage(err)}`,
					path: resolvedPath,
				});
				continue;
			}

			for (const filePath of files) {
				try {
					const raw = await Bun.file(filePath).text();
					const { frontmatter, body } = parseFrontmatter(raw);
					const rawDescription = frontmatter.description;
					let description = typeof rawDescription === "string" ? rawDescription : "";
					if (!description) {
						const firstLine = body.split("\n").find(line => line.trim());
						if (firstLine) {
							description = firstLine.slice(0, 60);
							if (firstLine.length > 60) {
								description += "...";
							}
						}
					}

					const source = "(legacy-resource-loader)";
					prompts.push({
						name: path.basename(filePath, path.extname(filePath)),
						description: description ? `${description} ${source}` : source,
						content: body,
						source,
					});
				} catch (err) {
					diagnostics.push({
						type: "warning",
						message: `Failed to load additional prompt template: ${errorMessage(err)}`,
						path: filePath,
					});
				}
			}
		}

		return { prompts, diagnostics };
	}

	get loaded(): boolean {
		return this.#loaded;
	}

	__getResolverState(): {
		cwd: string;
		agentDir: string;
		settingsPromise?: Promise<Settings>;
		eventBus: EventBus;
		extensionsResult: LoadExtensionsResult;
		skills: Skill[];
		prompts: PromptTemplate[];
		agentsFiles: AgentsFile[];
		systemPrompt: string | undefined;
		appendSystemPrompt: string[];
		extensionFactories: ExtensionFactory[];
	} {
		return {
			cwd: this.#state.cwd,
			agentDir: this.#state.agentDir,
			settingsPromise: this.#state.settingsPromise,
			eventBus: this.#state.eventBus,
			extensionsResult: this.#extensionsResult,
			skills: this.#skills,
			prompts: this.#prompts,
			agentsFiles: this.#agentsFiles,
			systemPrompt: this.#systemPrompt,
			appendSystemPrompt: this.#appendSystemPrompt,
			extensionFactories: this.#state.extensionFactories,
		};
	}
}

export type LegacyPiCreateAgentSessionOptions = CreateAgentSessionOptions & {
	resourceLoader?: ResourceLoader;
};

export async function createAgentSession(
	options: LegacyPiCreateAgentSessionOptions = {},
): Promise<CreateAgentSessionResult> {
	const loader = options.resourceLoader;
	if (!loader) {
		return ompCreateAgentSession(options);
	}

	if (loader instanceof DefaultResourceLoader && !loader.loaded) {
		await loader.reload();
	}

	const state =
		loader instanceof DefaultResourceLoader
			? loader.__getResolverState()
			: {
					cwd: options.cwd ?? getProjectDir(),
					agentDir: options.agentDir ?? getAgentDir(),
					settingsPromise: undefined,
					eventBus: undefined,
					extensionsResult: loader.getExtensions(),
					skills: loader.getSkills().skills,
					prompts: loader.getPrompts().prompts,
					agentsFiles: loader.getAgentsFiles().agentsFiles,
					systemPrompt: loader.getSystemPrompt(),
					appendSystemPrompt: loader.getAppendSystemPrompt(),
					extensionFactories: [] as ExtensionFactory[],
				};

	const { resourceLoader: _, ...rest } = options;
	const forwarded: CreateAgentSessionOptions = {
		...rest,
		cwd: rest.cwd ?? state.cwd,
		agentDir: rest.agentDir ?? state.agentDir,
	};

	if (rest.eventBus === undefined && state.eventBus !== undefined) {
		forwarded.eventBus = state.eventBus;
	}
	if (rest.settings === undefined && rest.settingsManager === undefined && state.settingsPromise !== undefined) {
		forwarded.settingsManager = state.settingsPromise;
	}

	if (rest.preloadedExtensions === undefined && rest.preloadedExtensionPaths === undefined) {
		forwarded.preloadedExtensions = state.extensionsResult;
	}

	if (rest.skills === undefined) {
		forwarded.skills = state.skills;
	}
	if (rest.promptTemplates === undefined) {
		forwarded.promptTemplates = state.prompts;
	}
	if (rest.contextFiles === undefined) {
		forwarded.contextFiles = state.agentsFiles;
	}

	if (rest.systemPrompt === undefined && state.systemPrompt !== undefined) {
		forwarded.systemPrompt = state.systemPrompt;
	}
	if (rest.appendSystemPrompt === undefined && state.appendSystemPrompt.length > 0) {
		forwarded.appendSystemPrompt = state.appendSystemPrompt.join("\n\n");
	}

	return ompCreateAgentSession(forwarded);
}

export * from "../index";
export { formatBytes as formatSize } from "../tools/render-utils";
export { Type } from "./typebox";
