import * as fs from "node:fs";
import path from "node:path";
import {
	atomicWriteFilePreservingMode,
	errorMessage,
	logger,
	once,
	pathExists,
	readPipeText,
	trimTrailingSlashes,
	untilAborted,
} from "@veyyon/utils";
import type { BunFile } from "bun";
import { adoptIntoPrimarySessionCpuBudget } from "../session/cpu-limit";
import { formatPathRelativeToCwd } from "../tools/path-utils";
import { ToolAbortError, throwIfAborted } from "../tools/tool-errors";
import { isTimeoutError, scopedTimeoutSignal } from "../utils/fetch-timeout";
import {
	FileChangeType,
	getActiveClients,
	getOrCreateClient,
	type LspServerStatus,
	notifySaved,
	notifyWorkspaceWatchedFiles,
	sendNotification,
	sendRequest,
	setIdleTimeout,
	syncContent,
	WARMUP_TIMEOUT_MS,
	waitForProjectLoaded,
} from "./client";
import { getLinterClient } from "./clients";
import { getServersForFile, hasRootMarkerAncestor, type LspConfig, loadConfig } from "./config";
import { applyTextEditsToString } from "./edits";
import { resolveFormatOptions } from "./format-options";
import type {
	Diagnostic,
	Location,
	LocationLink,
	LspClient,
	Position,
	PublishedDiagnostics,
	ServerConfig,
	TextEdit,
} from "./types";
import {
	fileToUri,
	formatDiagnostic,
	formatDiagnosticsSummary,
	formatLocation,
	rangeContainsPosition,
	readLocationContext,
	sortDiagnostics,
	summarizeDiagnosticMessages,
	uriToFile,
} from "./utils";

export const LSP_READONLY_ACTIONS: ReadonlySet<string> = new Set([
	"diagnostics",
	"definition",
	"type_definition",
	"implementation",
	"references",
	"hover",
	"symbols",
	"status",
	"capabilities",
]);
export interface LspStartupServerInfo {
	name: string;
	status: "connecting" | "ready" | "error" | "available";
	fileTypes: string[];
	error?: string;
}
export interface LspWarmupResult {
	servers: Array<LspStartupServerInfo & { status: "ready" | "error" }>;
}
export interface LspWarmupOptions {
	onConnecting?: (serverNames: string[]) => void;
}
export function discoverStartupLspServers(
	cwd: string,
	status: LspStartupServerInfo["status"] = "connecting",
): LspStartupServerInfo[] {
	const config = loadConfig(cwd);
	return getLspServers(config).map(([name, serverConfig]) => ({
		name,
		status,
		fileTypes: serverConfig.fileTypes,
	}));
}
export async function warmupLspServers(cwd: string, options?: LspWarmupOptions): Promise<LspWarmupResult> {
	const config = loadConfig(cwd);
	setIdleTimeout(config.idleTimeoutMs);
	const servers: LspWarmupResult["servers"] = [];
	const lspServers = getLspServers(config);

	if (lspServers.length > 0 && options?.onConnecting) {
		options.onConnecting(lspServers.map(([name]) => name));
	}

	const results = await Promise.allSettled(
		lspServers.map(async ([name, serverConfig]) => {
			const client = await getOrCreateClient(serverConfig, cwd, serverConfig.warmupTimeoutMs ?? WARMUP_TIMEOUT_MS);
			return { name, client, fileTypes: serverConfig.fileTypes };
		}),
	);

	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		const [name, serverConfig] = lspServers[i];
		if (result.status === "fulfilled") {
			servers.push({
				name: result.value.name,
				status: "ready",
				fileTypes: result.value.fileTypes,
			});
		} else {
			const errorMsg = result.reason?.message ?? String(result.reason);
			logger.warn("LSP server failed to start", { server: name, error: errorMsg });
			servers.push({
				name,
				status: "error",
				fileTypes: serverConfig.fileTypes,
				error: errorMsg,
			});
		}
	}

	return { servers };
}
export function getLspStatus(): LspServerStatus[] {
	return getActiveClients();
}
async function syncFileContent(
	absolutePath: string,
	content: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	signal?: AbortSignal,
): Promise<void> {
	throwIfAborted(signal);
	await Promise.allSettled(
		servers.map(async ([_serverName, serverConfig]) => {
			throwIfAborted(signal);
			if (serverConfig.createClient) {
				return;
			}
			const client = await getOrCreateClient(serverConfig, cwd, undefined, signal);
			throwIfAborted(signal);
			await syncContent(client, absolutePath, content, signal);
		}),
	);
}
async function notifyFileSaved(
	absolutePath: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	signal?: AbortSignal,
): Promise<void> {
	throwIfAborted(signal);
	await Promise.allSettled(
		servers.map(async ([_serverName, serverConfig]) => {
			throwIfAborted(signal);
			if (serverConfig.createClient) {
				return;
			}
			const client = await getOrCreateClient(serverConfig, cwd, undefined, signal);
			await notifySaved(client, absolutePath, signal);
		}),
	);
}
export const configCache = new Map<string, LspConfig>();
export function getConfig(cwd: string): LspConfig {
	let config = configCache.get(cwd);
	if (!config) {
		config = loadConfig(cwd);
		setIdleTimeout(config.idleTimeoutMs);
		configCache.set(cwd, config);
	}
	return config;
}
function isCustomLinter(serverConfig: ServerConfig): boolean {
	return Boolean(serverConfig.createClient);
}
function splitServers(servers: Array<[string, ServerConfig]>): {
	lspServers: Array<[string, ServerConfig]>;
	customLinterServers: Array<[string, ServerConfig]>;
} {
	const lspServers: Array<[string, ServerConfig]> = [];
	const customLinterServers: Array<[string, ServerConfig]> = [];
	for (const entry of servers) {
		if (isCustomLinter(entry[1])) {
			customLinterServers.push(entry);
		} else {
			lspServers.push(entry);
		}
	}
	return { lspServers, customLinterServers };
}
export function getLspServers(config: LspConfig): Array<[string, ServerConfig]> {
	return (Object.entries(config.servers) as Array<[string, ServerConfig]>).filter(
		([, serverConfig]) => !isCustomLinter(serverConfig),
	);
}
export function getLspServersForFile(config: LspConfig, filePath: string): Array<[string, ServerConfig]> {
	return getServersForFile(config, filePath).filter(([, serverConfig]) => !isCustomLinter(serverConfig));
}
export function getLspServerForFile(config: LspConfig, filePath: string): [string, ServerConfig] | null {
	const servers = getLspServersForFile(config, filePath);
	return servers.length > 0 ? servers[0] : null;
}
export function isProjectAwareLspServer(serverConfig: ServerConfig): boolean {
	return !serverConfig.createClient && !serverConfig.isLinter;
}
export const DIAGNOSTIC_MESSAGE_LIMIT = 50;
export const SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS = 3000;
export const BATCH_DIAGNOSTICS_WAIT_TIMEOUT_MS = 400;
export const DIAGNOSTICS_POLL_MS = 100;
export const DIAGNOSTICS_SETTLE_MS = 250;
export const INLINE_DIAGNOSTICS_WAIT_TIMEOUT_MS = 500;
export const DEFERRED_DIAGNOSTICS_WAIT_TIMEOUT_MS = 12_000;
export const MAX_GLOB_DIAGNOSTIC_TARGETS = 20;
export const WORKSPACE_SYMBOL_LIMIT = 200;
export const PROJECT_INDEXED_ACTIONS: ReadonlySet<string> = new Set([
	"definition",
	"type_definition",
	"implementation",
	"references",
	"rename",
	"hover",
]);
export const RUST_WORKSPACE_MARKERS = ["Cargo.toml", "rust-analyzer.toml"] as const;
export function hasRustWorkspaceAncestor(filePath: string): boolean {
	let dir = path.dirname(filePath);
	while (true) {
		for (const marker of RUST_WORKSPACE_MARKERS) {
			if (fs.existsSync(path.join(dir, marker))) {
				return true;
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return false;
		}
		dir = parent;
	}
}
function limitDiagnosticMessages(messages: string[]): string[] {
	if (messages.length <= DIAGNOSTIC_MESSAGE_LIMIT) {
		return messages;
	}
	return messages.slice(0, DIAGNOSTIC_MESSAGE_LIMIT);
}
export const ORPHAN_TYPESCRIPT_PROJECT_DIAGNOSTIC_CODES: Record<number, true> = {
	1375: true,
	1378: true,
	2307: true,
	2580: true,
	2591: true,
	2792: true,
	2867: true,
};
function diagnosticCodeNumber(diagnostic: Diagnostic): number | null {
	if (typeof diagnostic.code === "number") return diagnostic.code;
	if (typeof diagnostic.code === "string" && /^\d+$/.test(diagnostic.code)) return Number(diagnostic.code);
	return null;
}
function isTypeScriptProjectDiagnostic(serverName: string, diagnostic: Diagnostic): boolean {
	if (diagnostic.source !== "typescript" && !serverName.toLowerCase().includes("typescript")) {
		return false;
	}
	const code = diagnosticCodeNumber(diagnostic);
	return code !== null && ORPHAN_TYPESCRIPT_PROJECT_DIAGNOSTIC_CODES[code] === true;
}
function filterOrphanProjectDiagnostics(
	absolutePath: string,
	serverName: string,
	serverConfig: ServerConfig,
	diagnostics: Diagnostic[],
): Diagnostic[] {
	if (!serverConfig.rootMarkers.length || hasRootMarkerAncestor(absolutePath, serverConfig.rootMarkers)) {
		return diagnostics;
	}
	return diagnostics.filter(diagnostic => !isTypeScriptProjectDiagnostic(serverName, diagnostic));
}
export const LOCATION_CONTEXT_LINES = 1;
export const REFERENCE_CONTEXT_LIMIT = 50;
export const REFERENCES_RETRY_COUNT = 2;
export const REFERENCES_RETRY_DELAY_MS = 250;
export function isOnlyQueriedDeclaration(locations: Location[], uri: string, position: Position): boolean {
	return locations.length === 1 && locations[0]?.uri === uri && rangeContainsPosition(locations[0].range, position);
}
export function normalizeLocationResult(
	result: Location | Location[] | LocationLink | LocationLink[] | null,
): Location[] {
	if (!result) return [];
	const raw = Array.isArray(result) ? result : [result];
	return raw.flatMap(loc => {
		if ("uri" in loc) {
			return [loc as Location];
		}
		if ("targetUri" in loc) {
			const link = loc as LocationLink;
			return [{ uri: link.targetUri, range: link.targetSelectionRange ?? link.targetRange }];
		}
		return [];
	});
}
export async function formatLocationWithContext(location: Location, cwd: string): Promise<string> {
	const header = `  ${formatLocation(location, cwd)}`;
	const context = await readLocationContext(
		uriToFile(location.uri),
		location.range.start.line + 1,
		LOCATION_CONTEXT_LINES,
	);
	if (context.length === 0) {
		return header;
	}
	return `${header}\n${context.map(lineText => `    ${lineText}`).join("\n")}`;
}
export const MAX_RENAME_PAIRS = 1000;
export interface FileRenamePair {
	oldUri: string;
	newUri: string;
}
export async function enumerateRenamePairs(
	source: string,
	dest: string,
): Promise<{ pairs: FileRenamePair[]; directory: boolean; exceeded: boolean }> {
	const stat = await fs.promises.stat(source);
	if (!stat.isDirectory()) {
		return {
			pairs: [{ oldUri: fileToUri(source), newUri: fileToUri(dest) }],
			directory: false,
			exceeded: false,
		};
	}
	const entries = await fs.promises.readdir(source, { recursive: true, withFileTypes: true });
	const pairs: FileRenamePair[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (pairs.length >= MAX_RENAME_PAIRS) {
			return { pairs, directory: true, exceeded: true };
		}
		const parent = entry.parentPath ?? source;
		const absOld = path.join(parent, entry.name);
		const rel = path.relative(source, absOld);
		pairs.push({
			oldUri: fileToUri(absOld),
			newUri: fileToUri(path.join(dest, rel)),
		});
	}
	return { pairs, directory: true, exceeded: false };
}
export function isMethodNotFoundError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const msg = err.message.toLowerCase();
	return (
		msg.includes("method not found") ||
		msg.includes("unhandled method") ||
		msg.includes("not supported") ||
		msg.includes("-32601")
	);
}
export async function reloadServer(client: LspClient, serverName: string, signal?: AbortSignal): Promise<string> {
	try {
		await sendRequest(client, "rust-analyzer/reloadWorkspace", null, signal);
		return `Reloaded ${serverName}`;
	} catch {}
	try {
		await sendNotification(client, "workspace/didChangeConfiguration", { settings: {} }, signal);
		return `Reloaded ${serverName}`;
	} catch {
		client.proc.kill();
		return `Restarted ${serverName}`;
	}
}
export interface WaitForDiagnosticsOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	minVersion?: number;
	expectedDocumentVersion?: number;
	settleMs?: number;
}
export async function waitForDiagnostics(
	client: LspClient,
	uri: string,
	options: WaitForDiagnosticsOptions = {},
): Promise<Diagnostic[]> {
	const { timeoutMs = 3000, signal, minVersion, expectedDocumentVersion, settleMs = DIAGNOSTICS_SETTLE_MS } = options;
	const start = Date.now();
	let settledRef: PublishedDiagnostics | undefined;
	let settledAt = 0;
	while (Date.now() - start < timeoutMs) {
		throwIfAborted(signal);
		const versionOk = minVersion === undefined || client.diagnosticsVersion > minVersion;
		const published = client.diagnostics.get(uri);
		if (published && versionOk) {
			if (expectedDocumentVersion !== undefined && published.version === expectedDocumentVersion) {
				return published.diagnostics;
			}
			if (published !== settledRef) {
				settledRef = published;
				settledAt = Date.now();
			} else if (Date.now() - settledAt >= settleMs) {
				return published.diagnostics;
			}
		}
		await Bun.sleep(DIAGNOSTICS_POLL_MS);
	}
	const versionOk = minVersion === undefined || client.diagnosticsVersion > minVersion;
	if (!versionOk) {
		return [];
	}
	return client.diagnostics.get(uri)?.diagnostics ?? [];
}
export interface ProjectType {
	type: "rust" | "typescript" | "go" | "python" | "unknown";
	command?: string[];
	description: string;
}
function goWorkspaceBuildPattern(diskPath: string): string | null {
	const trimmed = diskPath.trim();
	if (!trimmed) return null;

	const isAbsolute = path.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed);
	const normalized = trimTrailingSlashes(trimmed.replaceAll("\\", "/"));
	const dir = normalized || ".";
	if (dir === ".") return "./...";
	if (dir.endsWith("/...")) return dir;
	if (isAbsolute || dir.startsWith("./") || dir.startsWith("../")) return `${dir}/...`;
	return `./${dir}/...`;
}
function parseGoWorkspaceBuildPatterns(output: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		return [];
	}

	if (!parsed || typeof parsed !== "object" || !("Use" in parsed) || !Array.isArray(parsed.Use)) return [];

	const patterns = new Set<string>();
	for (const entry of parsed.Use) {
		if (!entry || typeof entry !== "object" || !("DiskPath" in entry) || typeof entry.DiskPath !== "string") {
			continue;
		}
		const pattern = goWorkspaceBuildPattern(entry.DiskPath);
		if (pattern) patterns.add(pattern);
	}
	return Array.from(patterns);
}
async function resolveGoWorkspaceDiagnosticsCommand(cwd: string, signal?: AbortSignal): Promise<string[]> {
	const fallback = ["go", "build", "./..."];
	try {
		const proc = Bun.spawn(["go", "work", "edit", "-json"], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		adoptIntoPrimarySessionCpuBudget(proc.pid);
		const abortHandler = () => {
			proc.kill();
		};
		if (signal) {
			signal.addEventListener("abort", abortHandler, { once: true });
		}

		try {
			const [stdout] = await Promise.all([readPipeText(proc.stdout), readPipeText(proc.stderr)]);
			const exitCode = await proc.exited;
			throwIfAborted(signal);
			if (exitCode !== 0) return fallback;
			const patterns = parseGoWorkspaceBuildPatterns(stdout);
			return patterns.length > 0 ? ["go", "build", ...patterns] : fallback;
		} finally {
			signal?.removeEventListener("abort", abortHandler);
		}
	} catch {
		if (signal?.aborted) {
			throw new ToolAbortError();
		}
		return fallback;
	}
}
async function detectProjectType(cwd: string, signal?: AbortSignal): Promise<ProjectType> {
	if (await pathExists(path.join(cwd, "Cargo.toml"), "a Rust project root")) {
		return { type: "rust", command: ["cargo", "check", "--message-format=short"], description: "Rust (cargo check)" };
	}

	if (await pathExists(path.join(cwd, "tsconfig.json"), "a TypeScript project root")) {
		return { type: "typescript", command: ["npx", "tsc", "--noEmit"], description: "TypeScript (tsc --noEmit)" };
	}

	if (await pathExists(path.join(cwd, "go.work"), "a Go workspace root")) {
		return {
			type: "go",
			command: await resolveGoWorkspaceDiagnosticsCommand(cwd, signal),
			description: "Go workspace (go build)",
		};
	}

	if (await pathExists(path.join(cwd, "go.mod"), "a Go module root")) {
		return { type: "go", command: ["go", "build", "./..."], description: "Go (go build)" };
	}

	if (
		(await pathExists(path.join(cwd, "pyproject.toml"), "a Python project root")) ||
		(await pathExists(path.join(cwd, "pyrightconfig.json"), "a Python project root"))
	) {
		return { type: "python", command: ["pyright"], description: "Python (pyright)" };
	}

	return { type: "unknown", description: "Unknown project type" };
}
export async function runWorkspaceDiagnostics(
	cwd: string,
	signal?: AbortSignal,
): Promise<{ output: string; projectType: ProjectType }> {
	throwIfAborted(signal);
	const projectType = await detectProjectType(cwd, signal);
	if (!projectType.command) {
		return {
			output: `Cannot detect project type. Supported: Rust (Cargo.toml), TypeScript (tsconfig.json), Go (go.work/go.mod), Python (pyproject.toml)`,
			projectType,
		};
	}
	try {
		const proc = Bun.spawn(projectType.command, {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		adoptIntoPrimarySessionCpuBudget(proc.pid);
		const abortHandler = () => {
			proc.kill();
		};
		if (signal) {
			signal.addEventListener("abort", abortHandler, { once: true });
		}

		try {
			const [stdout, stderr] = await Promise.all([readPipeText(proc.stdout), readPipeText(proc.stderr)]);
			await proc.exited;
			throwIfAborted(signal);
			const combined = (stdout + stderr).trim();
			if (!combined) {
				return { output: "No issues found", projectType };
			}
			const lines = combined.split("\n");
			if (lines.length > 50) {
				return { output: `${lines.slice(0, 50).join("\n")}\n[…${lines.length - 50}ln elided…]`, projectType };
			}
			return { output: combined, projectType };
		} finally {
			signal?.removeEventListener("abort", abortHandler);
		}
	} catch (e) {
		if (signal?.aborted) {
			throw new ToolAbortError();
		}
		return { output: `Failed to run ${projectType.command.join(" ")}: ${e}`, projectType };
	}
}
export interface FileDiagnosticsResult {
	server?: string;
	messages: string[];
	summary: string;
	errored: boolean;
	formatter?: FileFormatResult;
}
export type ServerVersionMap = Map<string, number>;
export interface GetDiagnosticsForFileOptions {
	signal?: AbortSignal;
	minVersions?: ServerVersionMap;
	expectedDocumentVersions?: ServerVersionMap;
	timeoutMs?: number;
}
async function captureDiagnosticVersions(
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	initTimeoutMs?: number,
	signal?: AbortSignal,
): Promise<ServerVersionMap> {
	const versions = new Map<string, number>();
	await Promise.allSettled(
		servers.map(async ([serverName, serverConfig]) => {
			if (serverConfig.createClient) return;
			const client = await getOrCreateClient(serverConfig, cwd, initTimeoutMs, signal);
			versions.set(serverName, client.diagnosticsVersion);
		}),
	);
	return versions;
}
async function captureOpenFileVersions(
	absolutePath: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	signal?: AbortSignal,
): Promise<ServerVersionMap> {
	const uri = fileToUri(absolutePath);
	const versions = new Map<string, number>();
	await Promise.allSettled(
		servers.map(async ([serverName, serverConfig]) => {
			const client = await getOrCreateClient(serverConfig, cwd, undefined, signal);
			const version = client.openFiles.get(uri)?.version;
			if (version !== undefined) {
				versions.set(serverName, version);
			}
		}),
	);
	return versions;
}
export async function getDiagnosticsForFile(
	absolutePath: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	options: GetDiagnosticsForFileOptions = {},
): Promise<FileDiagnosticsResult | undefined> {
	const { signal, minVersions, expectedDocumentVersions, timeoutMs } = options;
	if (servers.length === 0) {
		return undefined;
	}

	const uri = fileToUri(absolutePath);
	const relPath = formatPathRelativeToCwd(absolutePath, cwd);
	const allDiagnostics: Diagnostic[] = [];
	const serverNames: string[] = [];

	const results = await Promise.allSettled(
		servers.map(async ([serverName, serverConfig]) => {
			throwIfAborted(signal);
			if (serverConfig.createClient) {
				const linterClient = getLinterClient(serverName, serverConfig, cwd);
				const diagnostics = await linterClient.lint(absolutePath);
				return { serverName, serverConfig, diagnostics };
			}

			const client = await getOrCreateClient(serverConfig, cwd, undefined, signal);
			throwIfAborted(signal);
			if (isProjectAwareLspServer(serverConfig)) {
				await waitForProjectLoaded(client, signal);
				throwIfAborted(signal);
			}
			const minVersion = minVersions?.get(serverName);
			const expectedDocumentVersion = expectedDocumentVersions?.get(serverName);
			const diagnostics = await waitForDiagnostics(client, uri, {
				timeoutMs: timeoutMs ?? SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS,
				signal,
				minVersion,
				expectedDocumentVersion,
			});
			return { serverName, serverConfig, diagnostics };
		}),
	);

	for (const result of results) {
		if (result.status === "fulfilled") {
			serverNames.push(result.value.serverName);
			allDiagnostics.push(
				...filterOrphanProjectDiagnostics(
					absolutePath,
					result.value.serverName,
					result.value.serverConfig,
					result.value.diagnostics,
				),
			);
		}
	}

	if (serverNames.length === 0) {
		return undefined;
	}

	if (allDiagnostics.length === 0) {
		return {
			server: serverNames.join(", "),
			messages: [],
			summary: "OK",
			errored: false,
		};
	}

	const seen = new Set<string>();
	const uniqueDiagnostics: Diagnostic[] = [];
	for (const d of allDiagnostics) {
		const key = `${d.range.start.line}:${d.range.start.character}:${d.range.end.line}:${d.range.end.character}:${d.message}`;
		if (!seen.has(key)) {
			seen.add(key);
			uniqueDiagnostics.push(d);
		}
	}

	sortDiagnostics(uniqueDiagnostics);
	const formatted = uniqueDiagnostics.map(d => formatDiagnostic(d, relPath));
	const limited = limitDiagnosticMessages(formatted);
	const summary = formatDiagnosticsSummary(uniqueDiagnostics);
	const hasErrors = uniqueDiagnostics.some(d => d.severity === 1);

	return {
		server: serverNames.join(", "),
		messages: limited,
		summary,
		errored: hasErrors,
	};
}
export enum FileFormatResult {
	UNCHANGED = "unchanged",
	FORMATTED = "formatted",
}
async function formatContent(
	absolutePath: string,
	content: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	signal?: AbortSignal,
): Promise<string> {
	if (servers.length === 0) {
		return content;
	}

	const uri = fileToUri(absolutePath);

	for (const [serverName, serverConfig] of servers) {
		try {
			throwIfAborted(signal);
			if (serverConfig.createClient) {
				const linterClient = getLinterClient(serverName, serverConfig, cwd);
				return await linterClient.format(absolutePath, content);
			}

			const client = await getOrCreateClient(serverConfig, cwd, undefined, signal);
			throwIfAborted(signal);

			const caps = client.serverCapabilities;
			if (!caps?.documentFormattingProvider) {
				continue;
			}

			const edits = (await sendRequest(
				client,
				"textDocument/formatting",
				{
					textDocument: { uri },
					options: resolveFormatOptions(absolutePath, content),
				},
				signal,
			)) as TextEdit[] | null;

			if (!edits || edits.length === 0) {
				return content;
			}

			return applyTextEditsToString(content, edits);
		} catch (error) {
			if (signal?.aborted || error instanceof ToolAbortError || isTimeoutError(error)) throw error;
			logger.warn("LSP formatting failed; wrote unformatted content", {
				server: serverName,
				path: formatPathRelativeToCwd(absolutePath, cwd),
				error: errorMessage(error),
			});
		}
	}

	return content;
}
export interface WritethroughOptions {
	enableFormat?: boolean;
	enableDiagnostics?: boolean;
	onDeferredDiagnostics?: (diagnostics: FileDiagnosticsResult) => void;
	deferredSignal?: AbortSignal;
	transformDiagnostics?: (absPath: string, result: FileDiagnosticsResult) => FileDiagnosticsResult;
}
export type ResolvedWritethroughOptions = {
	enableFormat: boolean;
	enableDiagnostics: boolean;
	transformDiagnostics?: (absPath: string, result: FileDiagnosticsResult) => FileDiagnosticsResult;
};
export type WritethroughDeferredHandle = {
	onDeferredDiagnostics: (diagnostics: FileDiagnosticsResult) => void;
	signal: AbortSignal;
	finalize: (diagnostics: FileDiagnosticsResult | undefined) => void;
};
export type WritethroughCallback = (
	dst: string,
	content: string,
	signal?: AbortSignal,
	file?: BunFile,
	batch?: LspWritethroughBatchRequest,
	getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
) => Promise<FileDiagnosticsResult | undefined>;
export async function commitFileContentAtomic(dst: string, content: string, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	try {
		await atomicWriteFilePreservingMode(dst, content, { fsync: false });
	} catch (error) {
		throw new Error(`Failed to write ${dst}: ${errorMessage(error)}`, { cause: error });
	}
}
export async function writethroughNoop(
	dst: string,
	content: string,
	signal?: AbortSignal,
	_file?: BunFile,
	_batch?: LspWritethroughBatchRequest,
	_getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
): Promise<FileDiagnosticsResult | undefined> {
	await commitFileContentAtomic(dst, content, signal);
	return undefined;
}
export interface PendingWritethrough {
	dst: string;
	content: string;
	file?: BunFile;
	changeType: FileChangeType;
}
export interface LspWritethroughBatchRequest {
	id: string;
	flush: boolean;
}
export interface LspWritethroughBatchState {
	entries: Map<string, PendingWritethrough>;
	options: ResolvedWritethroughOptions;
}
export const writethroughBatches = new Map<string, LspWritethroughBatchState>();
function getOrCreateWritethroughBatch(
	id: string,
	options: ResolvedWritethroughOptions,
): LspWritethroughBatchState {
	const existing = writethroughBatches.get(id);
	if (existing) {
		existing.options.enableFormat ||= options.enableFormat;
		existing.options.enableDiagnostics ||= options.enableDiagnostics;
		existing.options.transformDiagnostics ??= options.transformDiagnostics;
		return existing;
	}
	const batch: LspWritethroughBatchState = {
		entries: new Map<string, PendingWritethrough>(),
		options: { ...options },
	};
	writethroughBatches.set(id, batch);
	return batch;
}
export async function flushLspWritethroughBatch(
	id: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<FileDiagnosticsResult | undefined> {
	const state = writethroughBatches.get(id);
	if (!state) {
		return undefined;
	}
	writethroughBatches.delete(id);
	return flushWritethroughBatch(Array.from(state.entries.values()), cwd, state.options, signal);
}
function mergeDiagnostics(
	results: Array<FileDiagnosticsResult | undefined>,
	options: ResolvedWritethroughOptions,
): FileDiagnosticsResult | undefined {
	const messages: string[] = [];
	const servers = new Set<string>();
	let hasResults = false;
	let hasFormatter = false;
	let formatted = false;

	for (const result of results) {
		if (!result) continue;
		hasResults = true;
		if (result.server) {
			for (const server of result.server.split(",")) {
				const trimmed = server.trim();
				if (trimmed) {
					servers.add(trimmed);
				}
			}
		}
		if (result.messages.length > 0) {
			for (let mi = 0; mi < result.messages.length; mi++) messages.push(result.messages[mi]!);
		}
		if (result.formatter !== undefined) {
			hasFormatter = true;
			if (result.formatter === FileFormatResult.FORMATTED) {
				formatted = true;
			}
		}
	}

	if (!hasResults && !hasFormatter) {
		return undefined;
	}

	let summary = options.enableDiagnostics ? "no issues" : "OK";
	let errored = false;
	let limitedMessages = messages;
	if (messages.length > 0) {
		const summaryInfo = summarizeDiagnosticMessages(messages);
		summary = summaryInfo.summary;
		errored = summaryInfo.errored;
		limitedMessages = limitDiagnosticMessages(messages);
	}
	const formatter = hasFormatter ? (formatted ? FileFormatResult.FORMATTED : FileFormatResult.UNCHANGED) : undefined;

	return {
		server: servers.size > 0 ? Array.from(servers).join(", ") : undefined,
		messages: limitedMessages,
		summary,
		errored,
		formatter,
	};
}
async function scheduleDeferredDiagnosticsFetch(args: {
	dst: string;
	cwd: string;
	servers: Array<[string, ServerConfig]>;
	minVersions: ServerVersionMap | undefined;
	expectedDocumentVersions: ServerVersionMap | undefined;
	signal: AbortSignal;
	callback: (diagnostics: FileDiagnosticsResult) => void;
}): Promise<void> {
	const deferredTimeout = scopedTimeoutSignal(25_000, args.signal);
	try {
		const diagnostics = await getDiagnosticsForFile(args.dst, args.cwd, args.servers, {
			signal: deferredTimeout.signal,
			minVersions: args.minVersions,
			expectedDocumentVersions: args.expectedDocumentVersions,
			timeoutMs: DEFERRED_DIAGNOSTICS_WAIT_TIMEOUT_MS,
		});
		if (args.signal.aborted || diagnostics === undefined) return;
		args.callback(diagnostics);
	} catch {
	} finally {
		deferredTimeout.cancel();
	}
}
async function fetchDiagnosticsWithDeferral(args: {
	dst: string;
	cwd: string;
	servers: Array<[string, ServerConfig]>;
	minVersions: ServerVersionMap | undefined;
	expectedDocumentVersions: ServerVersionMap | undefined;
	transformDiagnostics?: ResolvedWritethroughOptions["transformDiagnostics"];
	deferred?: { onDeferredDiagnostics: (diagnostics: FileDiagnosticsResult) => void; signal: AbortSignal };
	signal?: AbortSignal;
}): Promise<FileDiagnosticsResult | undefined> {
	const { dst, cwd, servers, minVersions, expectedDocumentVersions, transformDiagnostics, deferred, signal } = args;
	const apply = (d: FileDiagnosticsResult | undefined) =>
		d && transformDiagnostics ? transformDiagnostics(dst, d) : d;

	if (!deferred) {
		return apply(
			await getDiagnosticsForFile(dst, cwd, servers, {
				signal,
				minVersions,
				expectedDocumentVersions,
			}),
		);
	}

	const fetchPromise = getDiagnosticsForFile(dst, cwd, servers, {
		signal: deferred.signal,
		minVersions,
		expectedDocumentVersions,
		timeoutMs: DEFERRED_DIAGNOSTICS_WAIT_TIMEOUT_MS,
	});
	const INLINE_TIMEOUT = Symbol("inline-diagnostics-timeout");
	const raced = await Promise.race([
		fetchPromise,
		Bun.sleep(INLINE_DIAGNOSTICS_WAIT_TIMEOUT_MS).then(() => INLINE_TIMEOUT),
	]);
	if (raced !== INLINE_TIMEOUT) {
		return apply(raced as FileDiagnosticsResult | undefined);
	}
	void fetchPromise
		.then(diagnostics => {
			if (diagnostics && !deferred.signal.aborted) deferred.onDeferredDiagnostics(diagnostics);
		})
		.catch((error: unknown) => {
			logger.warn("deferred LSP diagnostics fetch failed; none were delivered", { error: errorMessage(error) });
		});
	return undefined;
}
export async function runLspWritethrough(
	dst: string,
	content: string,
	cwd: string,
	options: ResolvedWritethroughOptions,
	changeType: FileChangeType,
	signal?: AbortSignal,
	_file?: BunFile,
	deferred?: {
		onDeferredDiagnostics: (diagnostics: FileDiagnosticsResult) => void;
		signal: AbortSignal;
	},
): Promise<FileDiagnosticsResult | undefined> {
	const { enableFormat, enableDiagnostics } = options;

	let finalContent = content;
	const writeContent = (value: string) => commitFileContentAtomic(dst, value, signal);
	const getWritePromise = once(() => writeContent(finalContent));
	let writeNotified = false;
	const notifyWriteCommitted = async (notifySignal: AbortSignal | undefined = signal) => {
		if (writeNotified) return;
		writeNotified = true;
		try {
			await notifyWorkspaceWatchedFiles(cwd, [{ filePath: dst, type: changeType }], notifySignal);
		} catch (error) {
			if (notifySignal?.aborted && !signal?.aborted) {
				writeNotified = false;
				return;
			}
			throw error;
		}
	};
	if (!enableFormat && !enableDiagnostics) {
		await getWritePromise();
		await notifyWriteCommitted();
		return undefined;
	}

	const config = getConfig(cwd);
	const servers = getServersForFile(config, dst);

	if (servers.length === 0) {
		await getWritePromise();
		await notifyWriteCommitted();
		return undefined;
	}
	const { lspServers, customLinterServers } = splitServers(servers);
	const useCustomFormatter = enableFormat && customLinterServers.length > 0;

	const minVersions = enableDiagnostics ? await captureDiagnosticVersions(cwd, servers, 5_000, signal) : undefined;
	let expectedDocumentVersions: ServerVersionMap | undefined;

	let formatter: FileFormatResult | undefined;
	let diagnostics: FileDiagnosticsResult | undefined;
	let timedOut = false;
	let synced = false;
	let operationSignal: AbortSignal | undefined;
	const operationTimeout = scopedTimeoutSignal(5_000, signal);
	try {
		const opSignal = operationTimeout.signal;
		operationSignal = opSignal;
		opSignal.addEventListener(
			"abort",
			() => {
				if (isTimeoutError(opSignal.reason)) timedOut = true;
			},
			{ once: true },
		);
		await untilAborted(operationSignal, async () => {
			if (useCustomFormatter) {
				await writeContent(content);
				finalContent = await formatContent(dst, content, cwd, customLinterServers, operationSignal);
				formatter = finalContent !== content ? FileFormatResult.FORMATTED : FileFormatResult.UNCHANGED;
				await writeContent(finalContent);
				await notifyWriteCommitted(operationSignal);
				await syncFileContent(dst, finalContent, cwd, lspServers, operationSignal);
			} else {
				await syncFileContent(dst, content, cwd, lspServers, operationSignal);

				if (enableFormat) {
					finalContent = await formatContent(dst, content, cwd, lspServers, operationSignal);
					formatter = finalContent !== content ? FileFormatResult.FORMATTED : FileFormatResult.UNCHANGED;
				}

				if (finalContent !== content) {
					await syncFileContent(dst, finalContent, cwd, lspServers, operationSignal);
				}

				await getWritePromise();
				await notifyWriteCommitted(operationSignal);
			}

			if (enableDiagnostics) {
				expectedDocumentVersions = await captureOpenFileVersions(dst, cwd, lspServers, operationSignal);
			}

			await notifyFileSaved(dst, cwd, lspServers, operationSignal);
		});
		synced = true;
	} catch {
		if (timedOut) {
			formatter = undefined;
			diagnostics = undefined;
			if (deferred && !deferred.signal.aborted && enableDiagnostics) {
				void scheduleDeferredDiagnosticsFetch({
					dst,
					cwd,
					servers,
					minVersions,
					expectedDocumentVersions,
					signal: deferred.signal,
					callback: deferred.onDeferredDiagnostics,
				});
			}
		}
		await getWritePromise();
		await notifyWriteCommitted();
	} finally {
		operationTimeout.cancel();
	}

	if (synced && enableDiagnostics) {
		diagnostics = await fetchDiagnosticsWithDeferral({
			dst,
			cwd,
			servers,
			minVersions,
			expectedDocumentVersions,
			transformDiagnostics: options.transformDiagnostics,
			deferred,
			signal,
		});
	}

	if (formatter !== undefined) {
		diagnostics ??= {
			server: servers.map(([name]) => name).join(", "),
			messages: [],
			summary: "OK",
			errored: false,
		};
		diagnostics.formatter = formatter;
	}

	return diagnostics;
}
async function flushWritethroughBatch(
	batch: PendingWritethrough[],
	cwd: string,
	options: ResolvedWritethroughOptions,
	signal?: AbortSignal,
	getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
): Promise<FileDiagnosticsResult | undefined> {
	if (batch.length === 0) {
		return undefined;
	}
	const results: Array<FileDiagnosticsResult | undefined> = [];
	for (const entry of batch) {
		const bundle = getDeferred?.(entry.dst);
		const deferredInner =
			bundle &&
			({
				onDeferredDiagnostics: bundle.onDeferredDiagnostics,
				signal: bundle.signal,
			} as const);
		const diag = await runLspWritethrough(
			entry.dst,
			entry.content,
			cwd,
			options,
			entry.changeType,
			signal,
			entry.file,
			deferredInner,
		);
		bundle?.finalize(diag);
		results.push(diag);
	}
	return mergeDiagnostics(results, options);
}
export function createLspWritethrough(cwd: string, options?: WritethroughOptions): WritethroughCallback {
	const resolvedOptions: ResolvedWritethroughOptions = {
		enableFormat: options?.enableFormat ?? false,
		enableDiagnostics: options?.enableDiagnostics ?? false,
		transformDiagnostics: options?.transformDiagnostics,
	};
	return async (
		dst: string,
		content: string,
		signal?: AbortSignal,
		file?: BunFile,
		batch?: LspWritethroughBatchRequest,
		getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
	) => {
		const changeType = (await Bun.file(dst).exists()) ? FileChangeType.Changed : FileChangeType.Created;
		if (!batch) {
			const bundle = getDeferred?.(dst);
			const deferredInner =
				bundle &&
				({
					onDeferredDiagnostics: bundle.onDeferredDiagnostics,
					signal: bundle.signal,
				} as const);
			const diagnostics = await runLspWritethrough(
				dst,
				content,
				cwd,
				resolvedOptions,
				changeType,
				signal,
				file,
				deferredInner,
			);
			bundle?.finalize(diagnostics);
			return diagnostics;
		}

		const state = getOrCreateWritethroughBatch(batch.id, resolvedOptions);
		state.entries.set(dst, { dst, content, file, changeType });

		if (!batch.flush) {
			await writethroughNoop(dst, content, signal, file);
			return undefined;
		}

		writethroughBatches.delete(batch.id);
		return flushWritethroughBatch(Array.from(state.entries.values()), cwd, state.options, signal, getDeferred);
	};
}
