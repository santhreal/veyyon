import * as fs from "node:fs";
import path from "node:path";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@veyyon/agent-core";
import { errorMessage, logger, prompt, truncate, untilAborted } from "@veyyon/utils";
import { theme } from "../modes/theme/theme-binding";
import type { Theme } from "../modes/theme/theme-class";
import { toolsPrompts } from "../prompts/tools/rows";
import type { ToolSession } from "../tools";
import { truncateForPrompt } from "../tools/approval";
import { formatPathRelativeToCwd, resolveToCwd } from "../tools/path-utils";
import { prependResultNotice } from "../tools/result-notice";
import { ToolAbortError, ToolError, throwIfAborted } from "../tools/tool-errors";
import { clampTimeout, formatTimeoutClampNotice } from "../tools/tool-timeouts";
import { isTimeoutError, scopedTimeoutSignal } from "../utils/fetch-timeout";
import {
	ensureFileOpen,
	getActiveClients,
	getOrCreateClient,
	type LspServerStatus,
	refreshFile,
	sendNotification,
	sendRequest,
	waitForProjectLoaded,
} from "./client";
import { getLinterClient } from "./clients";
import { getServersForFile, type LspConfig } from "./config";
import { applyTextEdits, applyWorkspaceEdit, flattenWorkspaceTextEdits, rangesOverlap } from "./edits";
import {
	BATCH_DIAGNOSTICS_WAIT_TIMEOUT_MS,
	configCache,
	enumerateRenamePairs,
	formatLocationWithContext,
	getConfig,
	getLspServerForFile,
	getLspServers,
	getLspServersForFile,
	hasRustWorkspaceAncestor,
	isMethodNotFoundError,
	isOnlyQueriedDeclaration,
	isProjectAwareLspServer,
	LSP_READONLY_ACTIONS,
	MAX_GLOB_DIAGNOSTIC_TARGETS,
	MAX_RENAME_PAIRS,
	normalizeLocationResult,
	PROJECT_INDEXED_ACTIONS,
	REFERENCE_CONTEXT_LIMIT,
	REFERENCES_RETRY_COUNT,
	REFERENCES_RETRY_DELAY_MS,
	reloadServer,
	runWorkspaceDiagnostics,
	SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS,
	WORKSPACE_SYMBOL_LIMIT,
	waitForDiagnostics,
} from "./lsp-helpers";
import { detectLspmux } from "./lspmux";
import {
	type CodeAction,
	type CodeActionContext,
	type Command,
	type Diagnostic,
	type DocumentSymbol,
	type Hover,
	type Location,
	type LocationLink,
	type LspParams,
	type LspToolDetails,
	lspSchema,
	type ServerConfig,
	type SymbolInformation,
	type TextEdit,
	type WorkspaceEdit,
} from "./types";
import {
	applyCodeAction,
	dedupeWorkspaceSymbols,
	extractHoverText,
	fileToUri,
	filterWorkspaceSymbols,
	formatCodeAction,
	formatDiagnostic,
	formatDiagnosticsSummary,
	formatDocumentSymbol,
	formatGroupedDiagnosticMessages,
	formatLocation,
	formatSymbolInformation,
	formatWorkspaceEdit,
	resolveDiagnosticTargets,
	resolveSymbolColumn,
	sortDiagnostics,
	symbolKindToIcon,
	uriToFile,
} from "./utils";

export class LspTool implements AgentTool<typeof lspSchema, LspToolDetails, Theme> {
	readonly name = "lsp";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const rawAction = (args as Partial<LspParams>).action;
		const action = typeof rawAction === "string" ? rawAction.toLowerCase() : "";
		return LSP_READONLY_ACTIONS.has(action) ? "read" : "write";
	};
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<LspParams>;
		const lines = [`Action: ${typeof params.action === "string" ? params.action : "(missing)"}`];
		if (typeof params.file === "string" && params.file.length > 0) {
			lines.push(`File: ${truncateForPrompt(params.file)}`);
		}
		return lines;
	};
	readonly label = "LSP";
	readonly loadMode = "discoverable";
	readonly summary = "Query LSP (language server) for diagnostics, hover info, and references";
	readonly description: string;
	readonly parameters = lspSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(toolsPrompts["tools/lsp"].text);
	}

	static createIf(session: ToolSession): LspTool | null {
		if (session.enableLsp === false) return null;
		if (!session.settings.get("lsp.enabled")) return null;
		if (!session.settings.get("lsp.tool")) return null;
		return new LspTool(session);
	}

	async execute(
		_toolCallId: string,
		params: LspParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<LspToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<LspToolDetails>> {
		const timeoutSec = clampTimeout("lsp", params.timeout, this.session.settings.get("tools.maxTimeout"));
		const clampNotice = formatTimeoutClampNotice("lsp", params.timeout, timeoutSec);
		const operationTimeout = scopedTimeoutSignal(timeoutSec * 1000, signal);
		try {
			const result = await this.#executeWithSignal(params, operationTimeout.signal, signal, timeoutSec);
			return clampNotice ? prependResultNotice(result, clampNotice) : result;
		} finally {
			operationTimeout.cancel();
		}
	}

	async #executeWithSignal(
		params: LspParams,
		signal: AbortSignal,
		callerSignal: AbortSignal | undefined,
		timeoutSec: number,
	): Promise<AgentToolResult<LspToolDetails>> {
		const { action, file } = params;
		throwIfAborted(signal);

		const config = getConfig(this.session.cwd);

		if (action === "status") {
			return this.#handleStatus(params, config, signal);
		}

		if (action === "diagnostics") {
			return this.#handleDiagnostics(params, config, signal, timeoutSec);
		}

		if (action === "rename_file") {
			return this.#handleRenameFile(params, config, signal);
		}

		if (action === "capabilities") {
			return this.#handleCapabilities(params, config, signal);
		}

		if (action === "request") {
			return this.#handleRequest(params, config, signal);
		}

		const isWorkspace = file === "*";
		const requiresFile = !file && action !== "reload";

		if (requiresFile) {
			return {
				content: [
					{
						type: "text",
						text: "Error: file parameter required. Use `*` for workspace scope where supported.",
					},
				],
				details: { action, success: false },
			};
		}

		const resolvedFile = file && !isWorkspace ? resolveToCwd(file, this.session.cwd) : null;
		if (action === "symbols" && (isWorkspace || !resolvedFile)) {
			return this.#handleSymbols(params, config, signal);
		}

		if (action === "reload" && (isWorkspace || !resolvedFile)) {
			return this.#handleReload(params, config, signal);
		}

		return this.#handleLspRequest(params, config, signal, callerSignal, timeoutSec);
	}

	async #handleStatus(
		params: LspParams,
		config: LspConfig,
		_signal: AbortSignal,
	): Promise<AgentToolResult<LspToolDetails>> {
		const { action } = params;
		const configuredNames = Object.keys(config.servers);
		const lspmuxState = await detectLspmux();
		const lspmuxStatus = lspmuxState.available
			? lspmuxState.running
				? "lspmux: active (multiplexing enabled)"
				: "lspmux: installed but server not running"
			: "";

		const startedClients = getActiveClients();
		const startedByConfigName = new Map<string, LspServerStatus>();
		for (const [name, serverConfig] of Object.entries(config.servers)) {
			const matched = startedClients.find(c => c.name === serverConfig.command);
			if (matched) startedByConfigName.set(name, matched);
		}

		const lines: string[] = [];
		if (configuredNames.length === 0) {
			lines.push("No language servers configured for this project");
		} else {
			const labelled = configuredNames.map(name => {
				const started = startedByConfigName.get(name);
				if (!started) return `${name} (configured, not started)`;
				return `${name} (${started.status})`;
			});
			lines.push(`Language servers: ${labelled.join(", ")}`);
			lines.push(
				"  note: 'configured, not started' means the binary resolves on PATH but no request has spawned it yet; 'ready' means a client process is live for this cwd.",
			);
		}
		if (lspmuxStatus) lines.push(lspmuxStatus);

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { action, success: true, request: params },
		};
	}

	async #handleDiagnostics(
		params: LspParams,
		config: LspConfig,
		signal: AbortSignal,
		timeoutSec: number,
	): Promise<AgentToolResult<LspToolDetails>> {
		const { action, file } = params;
		if (file === "*") {
			const result = await runWorkspaceDiagnostics(this.session.cwd, signal);
			return {
				content: [
					{
						type: "text",
						text: `Workspace diagnostics (${result.projectType.description}):\n${result.output}`,
					},
				],
				details: { action, success: true, request: params },
			};
		}

		if (!file) {
			return {
				content: [
					{
						type: "text",
						text: "Error: file parameter required. Use `*` for workspace-wide diagnostics or a path/glob for specific files.",
					},
				],
				details: { action, success: false, request: params },
			};
		}

		let targets: string[];
		let truncatedGlobTargets = false;
		const resolvedTargets = await resolveDiagnosticTargets(file, this.session.cwd, MAX_GLOB_DIAGNOSTIC_TARGETS);
		targets = resolvedTargets.matches;
		truncatedGlobTargets = resolvedTargets.truncated;

		if (targets.length === 0) {
			return {
				content: [{ type: "text", text: `No files matched pattern: ${file}` }],
				details: { action, success: true, request: params },
			};
		}

		const detailed = targets.length > 1 || truncatedGlobTargets;
		const diagnosticsWaitTimeoutMs = detailed
			? Math.min(BATCH_DIAGNOSTICS_WAIT_TIMEOUT_MS, timeoutSec * 1000)
			: Math.min(SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS, timeoutSec * 1000);
		const results: string[] = [];
		const allServerNames = new Set<string>();
		if (truncatedGlobTargets) {
			results.push(
				`${theme.status.warning} Pattern matched more than ${MAX_GLOB_DIAGNOSTIC_TARGETS} files; showing first ${MAX_GLOB_DIAGNOSTIC_TARGETS}. Narrow the glob or use workspace diagnostics.`,
			);
		}

		for (const target of targets) {
			throwIfAborted(signal);
			const resolved = resolveToCwd(target, this.session.cwd);
			const servers = getServersForFile(config, resolved);
			if (servers.length === 0) {
				results.push(`${theme.status.error} ${target}: No language server found`);
				continue;
			}

			const uri = fileToUri(resolved);
			const relPath = formatPathRelativeToCwd(resolved, this.session.cwd);
			const allDiagnostics: Diagnostic[] = [];

			for (const [serverName, serverConfig] of servers) {
				allServerNames.add(serverName);
				try {
					throwIfAborted(signal);
					if (serverConfig.createClient) {
						const linterClient = getLinterClient(serverName, serverConfig, this.session.cwd);
						const diagnostics = await linterClient.lint(resolved);
						for (let di = 0; di < diagnostics.length; di++) allDiagnostics.push(diagnostics[di]!);
						continue;
					}
					const client = await getOrCreateClient(serverConfig, this.session.cwd, undefined, signal);
					if (isProjectAwareLspServer(serverConfig)) {
						await waitForProjectLoaded(client, signal);
						throwIfAborted(signal);
					}
					const minVersion = client.diagnosticsVersion;
					await refreshFile(client, resolved, signal);
					const expectedDocumentVersion = client.openFiles.get(uri)?.version;
					const diagnostics = await waitForDiagnostics(client, uri, {
						timeoutMs: diagnosticsWaitTimeoutMs,
						signal,
						minVersion,
						expectedDocumentVersion,
					});
					for (let di = 0; di < diagnostics.length; di++) allDiagnostics.push(diagnostics[di]!);
				} catch (err) {
					if (err instanceof ToolAbortError || signal?.aborted) {
						throw err;
					}
				}
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

			if (!detailed && targets.length === 1) {
				if (uniqueDiagnostics.length === 0) {
					return {
						content: [{ type: "text", text: "OK" }],
						details: { action, serverName: Array.from(allServerNames).join(", "), success: true },
					};
				}

				const summary = formatDiagnosticsSummary(uniqueDiagnostics);
				const formatted = uniqueDiagnostics.map(d => formatDiagnostic(d, relPath));
				const output = `${summary}:\n${formatGroupedDiagnosticMessages(formatted)}`;
				return {
					content: [{ type: "text", text: output }],
					details: { action, serverName: Array.from(allServerNames).join(", "), success: true },
				};
			}

			if (uniqueDiagnostics.length === 0) {
				results.push(`${theme.status.success} ${relPath}: no issues`);
			} else {
				const summary = formatDiagnosticsSummary(uniqueDiagnostics);
				results.push(`${theme.status.error} ${relPath}: ${summary}`);
				const formatted = uniqueDiagnostics.map(d => formatDiagnostic(d, relPath));
				results.push(formatGroupedDiagnosticMessages(formatted));
			}
		}

		return {
			content: [{ type: "text", text: results.join("\n") }],
			details: { action, serverName: Array.from(allServerNames).join(", "), success: true },
		};
	}

	async #handleRenameFile(
		params: LspParams,
		config: LspConfig,
		signal: AbortSignal,
	): Promise<AgentToolResult<LspToolDetails>> {
		const { action, file, new_name, apply } = params;
		if (!file || !new_name) {
			return {
				content: [
					{
						type: "text",
						text: "Error: rename_file requires both `file` (source path) and `new_name` (destination path)",
					},
				],
				details: { action, success: false, request: params },
			};
		}

		const source = resolveToCwd(file, this.session.cwd);
		const dest = resolveToCwd(new_name, this.session.cwd);

		if (source === dest) {
			return {
				content: [{ type: "text", text: "Error: source and destination paths are identical" }],
				details: { action, success: false, request: params },
			};
		}

		let sourceStat: fs.Stats;
		try {
			sourceStat = await fs.promises.stat(source);
		} catch {
			return {
				content: [
					{
						type: "text",
						text: `Error: source path does not exist: ${formatPathRelativeToCwd(source, this.session.cwd)}`,
					},
				],
				details: { action, success: false, request: params },
			};
		}

		let destExists = false;
		try {
			await fs.promises.stat(dest);
			destExists = true;
		} catch {}
		if (destExists) {
			return {
				content: [
					{
						type: "text",
						text: `Error: destination already exists: ${formatPathRelativeToCwd(dest, this.session.cwd)}`,
					},
				],
				details: { action, success: false, request: params },
			};
		}

		const enumerated = await enumerateRenamePairs(source, dest);
		if (enumerated.exceeded) {
			return {
				content: [
					{
						type: "text",
						text: `Error: directory contains more than ${MAX_RENAME_PAIRS} files; rename in smaller batches to keep LSP edits accurate`,
					},
				],
				details: { action, success: false, request: params },
			};
		}
		const { pairs } = enumerated;
		if (pairs.length === 0) {
			return {
				content: [{ type: "text", text: "Error: no files to rename" }],
				details: { action, success: false, request: params },
			};
		}

		const lspParams = { files: pairs };
		const allLspServers = getLspServers(config);
		const relevantNames = new Set<string>();
		const collectRelevant = (filePath: string) => {
			for (const [name] of getLspServersForFile(config, filePath)) {
				relevantNames.add(name);
			}
		};
		collectRelevant(source);
		collectRelevant(dest);
		for (const pair of pairs) {
			collectRelevant(uriToFile(pair.oldUri));
			collectRelevant(uriToFile(pair.newUri));
		}
		const servers = allLspServers.filter(([name]) => relevantNames.has(name));
		const respondingServers = new Set<string>();
		const perServerEdits: Array<{ serverName: string; edit: WorkspaceEdit }> = [];
		const serverNotes: string[] = [];

		for (const [serverName, serverConfig] of servers) {
			throwIfAborted(signal);
			try {
				const client = await getOrCreateClient(serverConfig, this.session.cwd, undefined, signal);
				if (isProjectAwareLspServer(serverConfig)) {
					await waitForProjectLoaded(client, signal);
				}
				const result = (await sendRequest(
					client,
					"workspace/willRenameFiles",
					lspParams,
					signal,
				)) as WorkspaceEdit | null;
				respondingServers.add(serverName);
				if (result && (result.changes || result.documentChanges)) {
					perServerEdits.push({ serverName, edit: result });
				}
			} catch (err) {
				if (err instanceof ToolAbortError || signal?.aborted) {
					throw err;
				}
				if (!isMethodNotFoundError(err)) {
					const msg = errorMessage(err);
					serverNotes.push(`  ${serverName}: ${msg}`);
				}
			}
		}

		const sourceLabel = formatPathRelativeToCwd(source, this.session.cwd);
		const destLabel = formatPathRelativeToCwd(dest, this.session.cwd);
		const fileCountLabel = sourceStat.isDirectory()
			? `${pairs.length} file${pairs.length !== 1 ? "s" : ""} under ${sourceLabel}`
			: sourceLabel;

		const shouldApply = apply !== false;
		if (!shouldApply) {
			const lines: string[] = [];
			lines.push(`Rename preview: ${fileCountLabel} → ${destLabel}`);
			if (perServerEdits.length === 0) {
				lines.push("  No LSP edits would be applied");
			} else {
				for (const { serverName, edit } of perServerEdits) {
					const edits = formatWorkspaceEdit(edit, this.session.cwd);
					if (edits.length === 0) continue;
					lines.push(`  ${serverName}:`);
					for (const e of edits) {
						lines.push(`    ${e}`);
					}
				}
			}
			if (serverNotes.length > 0) {
				lines.push("  Server notes:");
				for (let ni = 0; ni < serverNotes.length; ni++) lines.push(serverNotes[ni]!);
			}
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					action,
					serverName: Array.from(respondingServers).join(", "),
					success: true,
					request: params,
				},
			};
		}

		const summary: string[] = [];

		const serverConfigByName = new Map(servers);
		interface AcceptedBucket {
			primaryServer: string;
			edits: TextEdit[];
			discarded: number;
			conflictServers: Set<string>;
		}
		const acceptedByUri = new Map<string, AcceptedBucket>();
		for (const { serverName, edit } of perServerEdits) {
			const cfg = serverConfigByName.get(serverName);
			const incomingPrimary = cfg ? isProjectAwareLspServer(cfg) : false;
			const flat = flattenWorkspaceTextEdits(edit);
			for (const [uri, edits] of flat) {
				const existing = acceptedByUri.get(uri);
				if (!existing) {
					acceptedByUri.set(uri, {
						primaryServer: serverName,
						edits: edits.slice(),
						discarded: 0,
						conflictServers: new Set(),
					});
					continue;
				}
				const existingCfg = serverConfigByName.get(existing.primaryServer);
				const existingIsPrimary = existingCfg ? isProjectAwareLspServer(existingCfg) : false;
				if (incomingPrimary && !existingIsPrimary) {
					const keptOld: TextEdit[] = [];
					let discardedOld = 0;
					for (const oe of existing.edits) {
						if (edits.some(ne => rangesOverlap(ne.range, oe.range))) discardedOld++;
						else keptOld.push(oe);
					}
					if (discardedOld > 0) existing.conflictServers.add(existing.primaryServer);
					existing.discarded += discardedOld;
					existing.primaryServer = serverName;
					existing.edits = edits.concat(keptOld);
				} else {
					let discardedNew = 0;
					for (const ne of edits) {
						if (existing.edits.some(ae => rangesOverlap(ae.range, ne.range))) {
							discardedNew++;
						} else {
							existing.edits.push(ne);
						}
					}
					if (discardedNew > 0) {
						existing.conflictServers.add(serverName);
						existing.discarded += discardedNew;
					}
				}
			}
		}

		for (const [uri, bucket] of acceptedByUri) {
			const filePath = uriToFile(uri);
			await applyTextEdits(filePath, bucket.edits);
			const rel = formatPathRelativeToCwd(filePath, this.session.cwd);
			summary.push(`  ${bucket.primaryServer}: applied ${bucket.edits.length} edit(s) to ${rel}`);
			if (bucket.discarded > 0) {
				const others = Array.from(bucket.conflictServers).join(", ");
				summary.push(
					`    note: discarded ${bucket.discarded} overlapping edit(s) from ${others} (kept ${bucket.primaryServer})`,
				);
				logger.warn(
					`lsp rename_file: discarded ${bucket.discarded} overlapping edit(s) from ${others} on ${rel}; kept ${bucket.primaryServer}`,
				);
			}
		}

		await fs.promises.mkdir(path.dirname(dest), { recursive: true });
		await fs.promises.rename(source, dest);
		summary.push(`  Renamed ${sourceLabel} → ${destLabel}`);

		for (const [serverName, serverConfig] of servers) {
			try {
				const client = await getOrCreateClient(serverConfig, this.session.cwd, undefined, signal);
				for (const { oldUri } of pairs) {
					if (client.openFiles.has(oldUri)) {
						await sendNotification(client, "textDocument/didClose", { textDocument: { uri: oldUri } }, signal);
						client.openFiles.delete(oldUri);
					}
				}
				await sendNotification(client, "workspace/didRenameFiles", lspParams, signal);
			} catch (err) {
				if (err instanceof ToolAbortError || signal?.aborted) {
					throw err;
				}
				const msg = errorMessage(err);
				serverNotes.push(`  ${serverName}: ${msg}`);
			}
		}

		if (serverNotes.length > 0) {
			summary.push("  Server notes:");
			for (let ni = 0; ni < serverNotes.length; ni++) summary.push(serverNotes[ni]!);
		}

		const header = `Renamed ${fileCountLabel} → ${destLabel}`;
		return {
			content: [{ type: "text", text: `${header}\n${summary.join("\n")}` }],
			details: {
				action,
				serverName: Array.from(respondingServers).join(", "),
				success: true,
				request: params,
			},
		};
	}

	async #handleCapabilities(
		params: LspParams,
		config: LspConfig,
		signal: AbortSignal,
	): Promise<AgentToolResult<LspToolDetails>> {
		const { action, file } = params;
		let serverList: Array<[string, ServerConfig]>;
		if (file && file !== "*") {
			const resolved = resolveToCwd(file, this.session.cwd);
			serverList = getLspServersForFile(config, resolved);
			if (serverList.length === 0) {
				return {
					content: [{ type: "text", text: "No language server found for this file" }],
					details: { action, success: false, request: params },
				};
			}
		} else {
			serverList = getLspServers(config);
		}

		if (serverList.length === 0) {
			return {
				content: [{ type: "text", text: "No language servers configured" }],
				details: { action, success: false, request: params },
			};
		}

		const sections: string[] = [];
		const respondingServers = new Set<string>();
		for (const [serverName, serverConfig] of serverList) {
			throwIfAborted(signal);
			try {
				const client = await getOrCreateClient(serverConfig, this.session.cwd, undefined, signal);
				respondingServers.add(serverName);
				const caps = client.serverCapabilities ?? {};
				sections.push(`${serverName}:`);
				sections.push(`  capabilities: ${JSON.stringify(caps, null, 2).split("\n").join("\n  ")}`);
			} catch (err) {
				if (err instanceof ToolAbortError || signal?.aborted) {
					throw err;
				}
				const msg = errorMessage(err);
				sections.push(`${serverName}: failed to start (${msg})`);
			}
		}

		return {
			content: [{ type: "text", text: sections.join("\n") }],
			details: {
				action,
				serverName: Array.from(respondingServers).join(", "),
				success: true,
				request: params,
			},
		};
	}

	async #handleRequest(
		params: LspParams,
		config: LspConfig,
		signal: AbortSignal,
	): Promise<AgentToolResult<LspToolDetails>> {
		const { action, file, line, symbol, query } = params;
		const method = query?.trim();
		if (!method) {
			return {
				content: [
					{
						type: "text",
						text: "Error: action=request requires `query` to specify the LSP method name (e.g., 'rust-analyzer/expandMacro')",
					},
				],
				details: { action, success: false, request: params },
			};
		}

		let chosenServer: [string, ServerConfig] | null = null;
		let resolvedTarget: string | null = null;
		if (file && file !== "*") {
			resolvedTarget = resolveToCwd(file, this.session.cwd);
			chosenServer = getLspServerForFile(config, resolvedTarget);
			if (!chosenServer) {
				return {
					content: [{ type: "text", text: "No language server found for this file" }],
					details: { action, success: false, request: params },
				};
			}
		} else {
			const all = getLspServers(config);
			if (all.length === 0) {
				return {
					content: [{ type: "text", text: "No language servers configured" }],
					details: { action, success: false, request: params },
				};
			}
			chosenServer = all[0];
		}

		const [chosenName, chosenConfig] = chosenServer;
		let requestParams: unknown;
		if (params.payload !== undefined) {
			try {
				requestParams = JSON.parse(params.payload);
			} catch (err) {
				const msg = errorMessage(err);
				return {
					content: [{ type: "text", text: `Error: invalid JSON in payload: ${msg}` }],
					details: { action, serverName: chosenName, success: false, request: params },
				};
			}
		} else if (resolvedTarget) {
			const uri = fileToUri(resolvedTarget);
			if (line !== undefined) {
				const character = await resolveSymbolColumn(resolvedTarget, line, symbol);
				requestParams = { textDocument: { uri }, position: { line: line - 1, character } };
			} else {
				requestParams = { textDocument: { uri } };
			}
		} else {
			requestParams = {};
		}

		try {
			const client = await getOrCreateClient(chosenConfig, this.session.cwd, undefined, signal);
			if (resolvedTarget) {
				await ensureFileOpen(client, resolvedTarget, signal);
			}
			const result = await sendRequest(client, method, requestParams, signal);
			const formatted =
				result === null || result === undefined
					? "null"
					: typeof result === "string"
						? result
						: JSON.stringify(result, null, 2);
			return {
				content: [{ type: "text", text: `${chosenName} ← ${method}:\n${formatted}` }],
				details: { action, serverName: chosenName, success: true, request: params },
			};
		} catch (err) {
			if (err instanceof ToolAbortError || signal?.aborted) {
				throw new ToolAbortError();
			}
			const msg = errorMessage(err);
			const previewRaw = JSON.stringify(requestParams ?? null);
			const preview = truncate(previewRaw, 400, "...");
			return {
				content: [
					{ type: "text", text: `LSP error from ${chosenName} on ${method}: ${msg}\n  params: ${preview}` },
				],
				details: { action, serverName: chosenName, success: false, request: params },
			};
		}
	}

	async #handleSymbols(
		params: LspParams,
		config: LspConfig,
		signal: AbortSignal,
	): Promise<AgentToolResult<LspToolDetails>> {
		const { action, query } = params;
		const normalizedQuery = query?.trim();
		if (!normalizedQuery) {
			return {
				content: [{ type: "text", text: "Error: query parameter required for workspace symbol search" }],
				details: { action, success: false, request: params },
			};
		}
		const servers = getLspServers(config);
		if (servers.length === 0) {
			return {
				content: [{ type: "text", text: "No language server found for this action" }],
				details: { action, success: false, request: params },
			};
		}
		const aggregatedSymbols: SymbolInformation[] = [];
		const respondingServers = new Set<string>();
		for (const [workspaceServerName, workspaceServerConfig] of servers) {
			throwIfAborted(signal);
			try {
				const workspaceClient = await getOrCreateClient(workspaceServerConfig, this.session.cwd, undefined, signal);
				const workspaceResult = (await sendRequest(
					workspaceClient,
					"workspace/symbol",
					{ query: normalizedQuery },
					signal,
				)) as SymbolInformation[] | null;
				if (!workspaceResult || workspaceResult.length === 0) {
					continue;
				}
				respondingServers.add(workspaceServerName);
				const filtered = filterWorkspaceSymbols(workspaceResult, normalizedQuery);
				for (let si = 0; si < filtered.length; si++) aggregatedSymbols.push(filtered[si]!);
			} catch (err) {
				if (err instanceof ToolAbortError || signal?.aborted) {
					throw err;
				}
			}
		}
		const dedupedSymbols = dedupeWorkspaceSymbols(aggregatedSymbols);
		if (dedupedSymbols.length === 0) {
			return {
				content: [{ type: "text", text: `No symbols matching "${normalizedQuery}"` }],
				details: {
					action,
					serverName: Array.from(respondingServers).join(", "),
					success: true,
					request: params,
				},
			};
		}
		const limitedSymbols = dedupedSymbols.slice(0, WORKSPACE_SYMBOL_LIMIT);
		const lines = limitedSymbols.map(s => formatSymbolInformation(s, this.session.cwd));
		const truncationLine =
			dedupedSymbols.length > WORKSPACE_SYMBOL_LIMIT
				? `\n[…${dedupedSymbols.length - WORKSPACE_SYMBOL_LIMIT} symbols elided…]`
				: "";
		return {
			content: [
				{
					type: "text",
					text: `Found ${dedupedSymbols.length} symbol(s) matching "${normalizedQuery}":\n${lines.map(l => `  ${l}`).join("\n")}${truncationLine}`,
				},
			],
			details: {
				action,
				serverName: Array.from(respondingServers).join(", "),
				success: true,
				request: params,
			},
		};
	}

	async #handleReload(
		params: LspParams,
		_config: LspConfig,
		signal: AbortSignal,
	): Promise<AgentToolResult<LspToolDetails>> {
		const { action } = params;
		configCache.delete(this.session.cwd);
		const refreshedConfig = getConfig(this.session.cwd);
		const servers = getLspServers(refreshedConfig);
		if (servers.length === 0) {
			return {
				content: [{ type: "text", text: "No language server found for this action" }],
				details: { action, success: false, request: params },
			};
		}
		const outputs: string[] = [];
		for (const [workspaceServerName, workspaceServerConfig] of servers) {
			throwIfAborted(signal);
			try {
				const workspaceClient = await getOrCreateClient(workspaceServerConfig, this.session.cwd, undefined, signal);
				outputs.push(await reloadServer(workspaceClient, workspaceServerName, signal));
			} catch (err) {
				if (err instanceof ToolAbortError || signal?.aborted) {
					throw err;
				}
				const errorText = errorMessage(err);
				outputs.push(`Failed to reload ${workspaceServerName}: ${errorText}`);
			}
		}
		return {
			content: [{ type: "text", text: outputs.join("\n") }],
			details: { action, serverName: servers.map(([name]) => name).join(", "), success: true, request: params },
		};
	}

	async #handleLspRequest(
		params: LspParams,
		config: LspConfig,
		signal: AbortSignal,
		callerSignal: AbortSignal | undefined,
		timeoutSec: number,
	): Promise<AgentToolResult<LspToolDetails>> {
		const { action, file, line, symbol, query, new_name, apply } = params;
		const isWorkspace = file === "*";
		const resolvedFile = file && !isWorkspace ? resolveToCwd(file, this.session.cwd) : null;
		const serverInfo = resolvedFile ? getLspServerForFile(config, resolvedFile) : null;
		if (!serverInfo) {
			return {
				content: [{ type: "text", text: "No language server found for this action" }],
				details: { action, success: false },
			};
		}

		const [serverName, serverConfig] = serverInfo;

		try {
			const client = await getOrCreateClient(serverConfig, this.session.cwd, undefined, signal);
			const targetFile = resolvedFile;
			const isRustAnalyzerServer =
				serverName === "rust-analyzer" ||
				path.basename(serverConfig.command) === "rust-analyzer" ||
				(serverConfig.resolvedCommand ? path.basename(serverConfig.resolvedCommand) === "rust-analyzer" : false);
			const needsProjectIndex =
				targetFile !== null && PROJECT_INDEXED_ACTIONS.has(action) && isProjectAwareLspServer(serverConfig);
			const rustWorkspaceWait =
				needsProjectIndex && isRustAnalyzerServer && targetFile !== null && hasRustWorkspaceAncestor(targetFile);

			if (targetFile) {
				await ensureFileOpen(client, targetFile, signal);
			}
			if (rustWorkspaceWait) {
				await waitForProjectLoaded(client, signal);
			}

			if (
				targetFile &&
				line !== undefined &&
				!symbol &&
				(action === "references" || action === "rename" || action === "definition") &&
				isProjectAwareLspServer(serverConfig)
			) {
				throw new ToolError(
					`symbol is required for project-aware ${action}; pass symbol=<name>, optionally symbol#N for repeated occurrences`,
				);
			}
			const uri = targetFile ? fileToUri(targetFile) : "";
			const resolvedLine = line ?? 1;
			const resolvedCharacter = targetFile ? await resolveSymbolColumn(targetFile, resolvedLine, symbol) : 0;
			const position = { line: resolvedLine - 1, character: resolvedCharacter };

			let output: string;
			let useless = false;

			if (needsProjectIndex && !isRustAnalyzerServer) {
				await waitForProjectLoaded(client, signal);
			}

			switch (action) {
				case "definition": {
					const result = (await sendRequest(
						client,
						"textDocument/definition",
						{
							textDocument: { uri },
							position,
						},
						signal,
					)) as Location | Location[] | LocationLink | LocationLink[] | null;

					const locations = normalizeLocationResult(result);

					if (locations.length === 0) {
						output = "No definition found";
						useless = true;
					} else {
						const lines = await Promise.all(
							locations.map(location => formatLocationWithContext(location, this.session.cwd)),
						);
						output = `Found ${locations.length} definition(s):\n${lines.join("\n")}`;
					}
					break;
				}

				case "type_definition": {
					const result = (await sendRequest(
						client,
						"textDocument/typeDefinition",
						{
							textDocument: { uri },
							position,
						},
						signal,
					)) as Location | Location[] | LocationLink | LocationLink[] | null;

					const locations = normalizeLocationResult(result);

					if (locations.length === 0) {
						output = "No type definition found";
						useless = true;
					} else {
						const lines = await Promise.all(
							locations.map(location => formatLocationWithContext(location, this.session.cwd)),
						);
						output = `Found ${locations.length} type definition(s):\n${lines.join("\n")}`;
					}
					break;
				}

				case "implementation": {
					const result = (await sendRequest(
						client,
						"textDocument/implementation",
						{
							textDocument: { uri },
							position,
						},
						signal,
					)) as Location | Location[] | LocationLink | LocationLink[] | null;

					const locations = normalizeLocationResult(result);

					if (locations.length === 0) {
						output = "No implementation found";
						useless = true;
					} else {
						const lines = await Promise.all(
							locations.map(location => formatLocationWithContext(location, this.session.cwd)),
						);
						output = `Found ${locations.length} implementation(s):\n${lines.join("\n")}`;
					}
					break;
				}
				case "references": {
					let result: Location[] | null = null;
					for (let attempt = 0; attempt <= REFERENCES_RETRY_COUNT; attempt++) {
						result = (await sendRequest(
							client,
							"textDocument/references",
							{
								textDocument: { uri },
								position,
								context: { includeDeclaration: true },
							},
							signal,
						)) as Location[] | null;

						const locations = result ?? [];
						if (!isProjectAwareLspServer(serverConfig) || attempt === REFERENCES_RETRY_COUNT) {
							break;
						}
						if (locations.length > 0 && !isOnlyQueriedDeclaration(locations, uri, position)) {
							break;
						}

						await waitForProjectLoaded(client, signal);
						throwIfAborted(signal);
						await untilAborted(signal, () => Bun.sleep(REFERENCES_RETRY_DELAY_MS));
					}

					if (!result || result.length === 0) {
						output = "No references found";
						useless = true;
					} else {
						const contextualReferences = result.slice(0, REFERENCE_CONTEXT_LIMIT);
						const plainReferences = result.slice(REFERENCE_CONTEXT_LIMIT);
						const contextualLines = await Promise.all(
							contextualReferences.map(location => formatLocationWithContext(location, this.session.cwd)),
						);
						const plainLines = plainReferences.map(location => `  ${formatLocation(location, this.session.cwd)}`);
						const lines = plainLines.length
							? [
									...contextualLines,
									`  ... ${plainLines.length} additional reference(s) shown without context`,
									...plainLines,
								]
							: contextualLines;
						output = `Found ${result.length} reference(s):\n${lines.join("\n")}`;
					}
					break;
				}

				case "hover": {
					const result = (await sendRequest(
						client,
						"textDocument/hover",
						{
							textDocument: { uri },
							position,
						},
						signal,
					)) as Hover | null;

					if (!result?.contents) {
						output = "No hover information";
					} else {
						output = extractHoverText(result.contents);
					}
					break;
				}

				case "code_actions": {
					const diagnostics = client.diagnostics.get(uri)?.diagnostics ?? [];
					const context: CodeActionContext = {
						diagnostics,
						only: !apply && query ? [query] : undefined,
						triggerKind: 1,
					};

					const result = (await sendRequest(
						client,
						"textDocument/codeAction",
						{
							textDocument: { uri },
							range: { start: position, end: position },
							context,
						},
						signal,
					)) as (CodeAction | Command)[] | null;

					if (!result || result.length === 0) {
						output = "No code actions available";
						break;
					}

					if (apply === true && query) {
						const normalizedQuery = query.trim();
						if (normalizedQuery.length === 0) {
							output = "Error: query parameter required when apply=true for code_actions";
							break;
						}
						const parsedIndex = /^\d+$/.test(normalizedQuery) ? Number.parseInt(normalizedQuery, 10) : null;
						const selectedAction =
							parsedIndex !== null
								? result[parsedIndex]
								: result.find(actionItem =>
										actionItem.title.toLowerCase().includes(normalizedQuery.toLowerCase()),
									);

						if (!selectedAction) {
							const actionLines = result.map((actionItem, index) => `  ${formatCodeAction(actionItem, index)}`);
							output = `No code action matches "${normalizedQuery}". Available actions:\n${actionLines.join("\n")}`;
							break;
						}

						const appliedAction = await applyCodeAction(selectedAction, {
							resolveCodeAction: async actionItem =>
								(await sendRequest(client, "codeAction/resolve", actionItem, signal)) as CodeAction,
							applyWorkspaceEdit: async edit => applyWorkspaceEdit(edit, this.session.cwd),
							executeCommand: async commandItem => {
								await sendRequest(
									client,
									"workspace/executeCommand",
									{
										command: commandItem.command,
										arguments: commandItem.arguments ?? [],
									},
									signal,
								);
							},
						});

						if (!appliedAction) {
							output = `Action "${selectedAction.title}" has no workspace edit or command to apply`;
							break;
						}

						const summaryLines: string[] = [];
						if (appliedAction.edits.length > 0) {
							summaryLines.push("  Workspace edit:");
							const editLines = appliedAction.edits.map(item => `    ${item}`);
							for (let li = 0; li < editLines.length; li++) summaryLines.push(editLines[li]!);
						}
						if (appliedAction.executedCommands.length > 0) {
							summaryLines.push("  Executed command(s):");
							const cmdLines = appliedAction.executedCommands.map(commandName => `    ${commandName}`);
							for (let li = 0; li < cmdLines.length; li++) summaryLines.push(cmdLines[li]!);
						}

						output = `Applied "${appliedAction.title}":\n${summaryLines.join("\n")}`;
						break;
					}

					const actionLines = result.map((actionItem, index) => `  ${formatCodeAction(actionItem, index)}`);
					output = `${result.length} code action(s):\n${actionLines.join("\n")}`;
					break;
				}
				case "symbols": {
					if (!targetFile) {
						output = "Error: file parameter required for document symbols";
						break;
					}
					const result = (await sendRequest(
						client,
						"textDocument/documentSymbol",
						{
							textDocument: { uri },
						},
						signal,
					)) as (DocumentSymbol | SymbolInformation)[] | null;

					if (!result || result.length === 0) {
						output = "No symbols found";
						useless = true;
					} else {
						const relPath = formatPathRelativeToCwd(targetFile, this.session.cwd);
						if ("selectionRange" in result[0]) {
							const lines = (result as DocumentSymbol[]).flatMap(s => formatDocumentSymbol(s));
							output = `Symbols in ${relPath}:\n${lines.join("\n")}`;
						} else {
							const lines = (result as SymbolInformation[]).map(s => {
								const line = s.location.range.start.line + 1;
								const icon = symbolKindToIcon(s.kind);
								return `${icon} ${s.name} @ line ${line}`;
							});
							output = `Symbols in ${relPath}:\n${lines.join("\n")}`;
						}
					}
					break;
				}

				case "rename": {
					if (!new_name) {
						return {
							content: [{ type: "text", text: "Error: new_name parameter required for rename" }],
							details: { action, serverName, success: false },
						};
					}

					const result = (await sendRequest(
						client,
						"textDocument/rename",
						{
							textDocument: { uri },
							position,
							newName: new_name,
						},
						signal,
					)) as WorkspaceEdit | null;

					if (!result) {
						output = "Rename returned no edits";
					} else {
						const shouldApply = apply !== false;
						if (shouldApply) {
							const applied = await applyWorkspaceEdit(result, this.session.cwd);
							output = `Applied rename:\n${applied.map(a => `  ${a}`).join("\n")}`;
						} else {
							const preview = formatWorkspaceEdit(result, this.session.cwd);
							output = `Rename preview:\n${preview.map(p => `  ${p}`).join("\n")}`;
						}
					}
					break;
				}

				case "reload": {
					output = await reloadServer(client, serverName, signal);
					break;
				}

				default:
					output = `Unknown action: ${action}`;
			}

			return {
				content: [{ type: "text", text: output }],
				details: { serverName, action, success: true, request: params },
				...(useless ? { useless: true } : {}),
			};
		} catch (err) {
			if (err instanceof ToolError) throw err;
			if (err instanceof ToolAbortError || signal?.aborted) {
				if (isTimeoutError(signal.reason) && !callerSignal?.aborted) {
					throw new ToolError(
						`LSP ${action} timed out after ${timeoutSec}s on ${serverName}. The server may still be indexing; try again or pass timeout=<larger>.`,
					);
				}
				throw new ToolAbortError();
			}
			const errorText = errorMessage(err);
			return {
				content: [{ type: "text", text: `LSP error: ${errorText}` }],
				details: { serverName, action, success: false, request: params },
			};
		}
	}
}
