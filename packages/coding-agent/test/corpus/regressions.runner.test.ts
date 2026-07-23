import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseGalleryStates } from "@veyyon/coding-agent/cli/gallery-cli";
import { parseUnreleasedSection } from "@veyyon/coding-agent/commit/changelog/parse";
import { extractPathFromRename, parseFileDiffs, parseNumstat } from "@veyyon/coding-agent/commit/git/diff";
import { parseJsonPayload } from "@veyyon/coding-agent/commit/utils/analysis";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	type CodexAutoRedeemMode,
	getDefault,
	SETTINGS_SCHEMA,
	type SettingPath,
} from "@veyyon/coding-agent/config/settings-schema";
import { createMCPToolName, parseMCPToolName } from "@veyyon/coding-agent/mcp/tool-bridge";
import {
	dispatchRpcInputFrame,
	RpcInputDispatcher,
	type RpcInputFrameDeps,
	rpcErrorResponse,
	rpcSuccessResponse,
	rpcUnknownCommandResponse,
} from "@veyyon/coding-agent/modes/rpc/rpc-mode";
import type { RpcCommand, RpcResponse } from "@veyyon/coding-agent/modes/rpc/rpc-types";
import {
	type CodexAutoRedeemInput,
	evaluateCodexAutoRedeem,
	shouldEvaluateCodexAutoRedeem,
	shouldPromptCodexAutoRedeem,
} from "@veyyon/coding-agent/session/codex-auto-reset";
import { findCompactMode, parseCompactArgs } from "@veyyon/coding-agent/session/compact-modes";
import { normalizeRoots } from "@veyyon/coding-agent/session/relativize-paths";
import {
	parseTitleSlotLine,
	serializeTitleSlot,
	titleUpdateFromSlot,
} from "@veyyon/coding-agent/session/session-title-slot";
import { formatShakeSummary, type ShakeResult } from "@veyyon/coding-agent/session/shake-types";
import {
	type ApprovalMode,
	type ApprovalResolutionOptions,
	resolveApproval,
	type ToolApproval,
} from "@veyyon/coding-agent/tools/approval";
import { astEditFilesystemTargets } from "@veyyon/coding-agent/tools/ast-edit";
import { parseConflictUri, scanConflictLines } from "@veyyon/coding-agent/tools/conflict-detect";
import {
	cwdEscapingTargets,
	formatCwdBoundaryReason,
	searchPathFilesystemTargets,
} from "@veyyon/coding-agent/tools/cwd-boundary";
import {
	buildSearchDateQualifier,
	parsePositiveDecimalInt,
	parseSearchDateBound,
	resolveTailLimit,
} from "@veyyon/coding-agent/tools/gh";
import { formatShortSha } from "@veyyon/coding-agent/tools/gh-format";
import { parseIssueUrl, parsePrUrl } from "@veyyon/coding-agent/tools/gh-url";
import { isWaitingPollDetails } from "@veyyon/coding-agent/tools/job";
import { applyListLimit } from "@veyyon/coding-agent/tools/list-limit";
import { formatMatchLine } from "@veyyon/coding-agent/tools/match-line-format";
import {
	formatFullOutputReference,
	formatTruncationMetaNotice,
	stripGeneratedOutputNotice,
	stripRawOutputArtifactNotice,
	type TruncationMeta,
} from "@veyyon/coding-agent/tools/output-meta";
import {
	combineSearchGlobs,
	expandPath,
	formatPathRelativeToCwd,
	globSearchBase,
	isPathWithinCwd,
	normalizeLocalScheme,
	normalizeWindowsDriveAliasPath,
	parseFindPattern,
	parseLineRangeChunk,
	parseLineRanges,
	parseSearchPath,
	resolveToCwd,
} from "@veyyon/coding-agent/tools/path-utils";
import { enforcePlanModeWrite, unwrapHashlineHeaderPath } from "@veyyon/coding-agent/tools/plan-mode-guard";
import { type FindingPriority, getPriorityInfo, isFindingPriority } from "@veyyon/coding-agent/tools/review";
import {
	clampTimeout,
	describeTimeoutParam,
	formatTimeoutClampNotice,
	type ToolWithTimeout,
} from "@veyyon/coding-agent/tools/tool-timeouts";
import { writeFilesystemTargets } from "@veyyon/coding-agent/tools/write";
import { detectLanguageId } from "@veyyon/coding-agent/utils/lang-from-path";
import { formatIsoDate, formatMediaDuration } from "@veyyon/coding-agent/web/scrapers/types";
import { InMemoryFilesystem, InMemorySnapshotStore, Patch, Patcher, parsePatch, Recovery } from "@veyyon/hashline";
import type { CorpusCase } from "../helpers/corpus-loader";
import { flattenCorpus, loadCorpusFile } from "../helpers/corpus-loader";
import { makeToolSession } from "../helpers/tool-session";

/**
 * Drives shipped product APIs from the regression corpus.
 * Each surface handler must call the real export and assert exact expects.
 * Adding a corpus row without a handler fails the suite (unknown surface).
 */

const CORPUS_DIR = path.join(import.meta.dir, "regressions");

function nullishToNull(value: unknown): unknown {
	return value === undefined ? null : value;
}

function runListLimit(c: CorpusCase): void {
	const input = c.input as { items: unknown[]; options: Parameters<typeof applyListLimit>[1] };
	const result = applyListLimit(input.items, input.options ?? {});
	const exp = c.expect as {
		items: unknown[];
		limitReached: number | null;
		meta: Record<string, unknown>;
	};
	expect(result.items).toEqual(exp.items);
	expect(nullishToNull(result.limitReached)).toBe(exp.limitReached);
	expect(result.meta).toEqual(exp.meta);
}

function runMatchLine(c: CorpusCase): void {
	const input = c.input as {
		lineNumber: number;
		line: string;
		isMatch: boolean;
		useHashLines: boolean;
	};
	const text = formatMatchLine(input.lineNumber, input.line, input.isMatch, {
		useHashLines: input.useHashLines,
	});
	const exp = c.expect as { text: string };
	expect(text).toBe(exp.text);
}

function runUnwrap(c: CorpusCase): void {
	const input = c.input as { path: string };
	const exp = c.expect as { path: string };
	expect(unwrapHashlineHeaderPath(input.path)).toBe(exp.path);
}

function runMcpToolName(c: CorpusCase): void {
	const input = c.input as { server: string; tool: string };
	const exp = c.expect as { name: string; serverName: string; toolName: string };
	const name = createMCPToolName(input.server, input.tool);
	expect(name).toBe(exp.name);
	expect(parseMCPToolName(name)).toEqual({
		serverName: exp.serverName,
		toolName: exp.toolName,
	});
}

async function runHashlineApply(c: CorpusCase): Promise<void> {
	const input = c.input as {
		files: Record<string, string>;
		patchLines: string[];
		mustThrow?: boolean;
	};
	const exp = c.expect as {
		files: Record<string, string>;
		sectionCount?: number;
		errorContains?: string;
	};
	const mem = new InMemoryFilesystem(Object.entries(input.files));
	const snapshots = new InMemorySnapshotStore();
	const tags: Record<string, string> = {};
	for (const [p, content] of Object.entries(input.files)) {
		tags[p] = snapshots.record(p, content);
	}
	// Replace TAG / TAG_A / TAG_B placeholders with real snapshot tags.
	const firstPath = Object.keys(input.files)[0]!;
	const rendered = input.patchLines
		.map(line =>
			line
				.replace(/#TAG_A\b/g, `#${tags["a.ts"] ?? tags[firstPath]!}`)
				.replace(/#TAG_B\b/g, `#${tags["b.ts"] ?? ""}`)
				.replace(/#TAG\b/g, `#${tags[firstPath]!}`),
		)
		.join("\n");
	const patcher = new Patcher({ fs: mem, snapshots });
	const patch = Patch.parse(rendered);
	if (input.mustThrow) {
		const err = await patcher.apply(patch).then(
			() => null,
			e => e as Error,
		);
		expect(err).not.toBeNull();
		if (exp.errorContains) {
			expect(String(err?.message ?? "").toLowerCase()).toContain(exp.errorContains.toLowerCase());
		}
	} else {
		const result = await patcher.apply(patch);
		if (exp.sectionCount !== undefined) {
			expect(result.sections).toHaveLength(exp.sectionCount);
		}
	}
	for (const [p, content] of Object.entries(exp.files)) {
		expect(mem.get(p)).toBe(content);
	}
}

const emptyStateData = {
	thinkingLevel: undefined,
	isStreaming: false,
	isCompacting: false,
	steeringMode: "all" as const,
	followUpMode: "all" as const,
	interruptMode: "immediate" as const,
	sessionId: "corpus-session",
	autoCompactionEnabled: false,
	messageCount: 0,
	queuedMessageCount: 0,
	todoPhases: [] as [],
};

function makeRpcDeps(handleCommand: RpcInputFrameDeps["handleCommand"]) {
	const outputs: Array<RpcResponse | object> = [];
	const deps: RpcInputFrameDeps = {
		handleCommand,
		output: obj => {
			outputs.push(obj as RpcResponse | object);
		},
		// Product error frame builder — same function runRpcMode wires.
		errorResponse: rpcErrorResponse,
		pendingExtensionRequests: new Map(),
		onHostToolResult: () => {},
		onHostToolUpdate: () => {},
		onHostUriResult: () => {},
	};
	return { deps, outputs };
}

function assertRpcFrame(
	frame: RpcResponse & { error?: string },
	exp: {
		id: string | null;
		type: string;
		command: string;
		success: boolean;
		errorContains?: string;
	},
): void {
	expect(nullishToNull(frame.id)).toBe(exp.id);
	// frame.type is the narrow "response" literal; the corpus expectation is a
	// plain string, so widen the matcher to compare their runtime values.
	expect(frame.type).toBe<string>(exp.type);
	expect(frame.command).toBe(exp.command);
	expect(frame.success).toBe(exp.success);
	if (exp.errorContains) {
		expect(String(frame.error ?? "")).toContain(exp.errorContains);
	}
}

async function runRpcParse(c: CorpusCase): Promise<void> {
	const input = c.input as { frame: unknown; variant?: string };
	const exp = c.expect as {
		id: string | null;
		type: string;
		command: string;
		success: boolean;
		errorContains: string;
	};
	// Unused success path still uses the product success builder.
	const { deps, outputs } = makeRpcDeps(async command =>
		rpcSuccessResponse(command.id, "prompt", { agentInvoked: false }),
	);
	const dispatcher = new RpcInputDispatcher({ deps });
	const frame = input.variant === "undefined" ? undefined : input.frame;
	dispatcher.dispatch(frame);
	expect(outputs).toHaveLength(1);
	assertRpcFrame(outputs[0] as RpcResponse & { error?: string }, exp);
}

async function runRpcUnknown(c: CorpusCase): Promise<void> {
	const input = c.input as { id?: string; type: string };
	const exp = c.expect as {
		id: string | null;
		type: string;
		command: string;
		success: boolean;
		errorContains: string;
	};
	// Drive the product default arm directly — request id is intentionally ignored.
	const frame = rpcUnknownCommandResponse(input.type);
	assertRpcFrame(frame as RpcResponse & { error?: string }, exp);
	// Also through the dispatcher so the handleCommand default path is the same function.
	const { deps, outputs } = makeRpcDeps(async command => {
		const type = (command as { type: string }).type;
		if (type === "get_state") {
			return rpcSuccessResponse(command.id, "get_state", emptyStateData);
		}
		return rpcUnknownCommandResponse(type);
	});
	await dispatchRpcInputFrame(input as RpcCommand, deps);
	expect(outputs).toHaveLength(1);
	assertRpcFrame(outputs[0] as RpcResponse & { error?: string }, exp);
	// Direct product call and dispatcher output must agree byte-for-byte on the contract fields.
	expect(nullishToNull((outputs[0] as RpcResponse).id)).toBe(nullishToNull(frame.id));
	expect((outputs[0] as RpcResponse).command).toBe(frame.command);
}

async function runRpcGetState(c: CorpusCase): Promise<void> {
	const input = c.input as { id?: string; type: string };
	const exp = c.expect as {
		id: string | null;
		type: string;
		command: string;
		success: boolean;
	};
	// Product success builder is the single owner of id echo on known commands.
	const frame = rpcSuccessResponse(input.id, "get_state", emptyStateData);
	assertRpcFrame(frame as RpcResponse & { error?: string }, exp);
	const { deps, outputs } = makeRpcDeps(async command => {
		if (command.type !== "get_state") {
			return rpcUnknownCommandResponse((command as { type: string }).type);
		}
		return rpcSuccessResponse(command.id, "get_state", emptyStateData);
	});
	await dispatchRpcInputFrame(input as RpcCommand, deps);
	expect(outputs).toHaveLength(1);
	assertRpcFrame(outputs[0] as RpcResponse & { error?: string }, exp);
	expect(nullishToNull((outputs[0] as RpcResponse).id)).toBe(nullishToNull(frame.id));
}

function runResolveApproval(c: CorpusCase): void {
	const input = c.input as {
		tool: { name: string; approval?: ToolApproval };
		args: unknown;
		mode: ApprovalMode;
		userConfig: Record<string, unknown>;
		options?: ApprovalResolutionOptions;
	};
	const exp = c.expect as {
		policy: string;
		tier: string;
		override: boolean;
		reasonContains?: string;
	};
	const result = resolveApproval(input.tool, input.args, input.mode, input.userConfig, input.options);
	// result fields are narrow literal unions; the corpus expectations are plain
	// strings, so widen the matchers to compare runtime values.
	expect(result.policy).toBe<string>(exp.policy);
	expect(result.tier).toBe<string>(exp.tier);
	expect(result.override).toBe(exp.override);
	if (exp.reasonContains) {
		expect(String(result.reason ?? "")).toContain(exp.reasonContains);
	}
}

function runSettingsGetDefault(c: CorpusCase): void {
	const input = c.input as { path: SettingPath };
	const exp = c.expect as { default: unknown; isolated: unknown };
	// Corpus expectations are `unknown`; settings values are the narrow schema
	// union. Widen the matchers to compare their runtime values.
	expect(getDefault(input.path)).toBe<unknown>(exp.default);
	const settings = Settings.isolated({});
	expect(settings.get(input.path)).toBe<unknown>(exp.isolated);
}

function runSettingsOverride(c: CorpusCase): void {
	const input = c.input as { overrides: Partial<Record<SettingPath, unknown>>; path: SettingPath };
	const exp = c.expect as { value: unknown };
	const settings = Settings.isolated(input.overrides);
	expect(settings.get(input.path)).toBe<unknown>(exp.value);
}

function runSettingsPathExists(c: CorpusCase): void {
	const input = c.input as { path: string };
	const exp = c.expect as { exists: boolean };
	expect(Object.hasOwn(SETTINGS_SCHEMA, input.path)).toBe(exp.exists);
}

function runHashlineRecovery(c: CorpusCase): void {
	const input = c.input as {
		path: string;
		seed?: Record<string, string>;
		seedVersions?: string[][];
		fileHash?: string;
		useHash?: number;
		current?: string;
		currentVersion?: number;
		patch: string;
	};
	const exp = c.expect as { recovered: boolean; contains?: string[] };
	const store = new InMemorySnapshotStore();
	let currentText = input.current ?? "";
	let fileHash = input.fileHash ?? "dead";
	if (input.seedVersions) {
		const hashes: string[] = [];
		for (const lines of input.seedVersions) {
			const body = `${lines.join("\n")}\n`;
			hashes.push(store.record(input.path, body));
		}
		fileHash = hashes[input.useHash ?? 0]!;
		const curLines = input.seedVersions[input.currentVersion ?? input.seedVersions.length - 1]!;
		currentText = `${curLines.join("\n")}\n`;
	} else if (input.seed) {
		for (const [p, content] of Object.entries(input.seed)) {
			const tag = store.record(p, content);
			if (p === input.path && !input.fileHash) fileHash = tag;
		}
		currentText = input.current ?? input.seed[input.path] ?? "";
	}
	const { edits } = parsePatch(input.patch);
	const recovered = new Recovery(store).tryRecover({
		path: input.path,
		currentText,
		fileHash,
		edits,
	});
	if (exp.recovered) {
		expect(recovered).not.toBeNull();
		for (const needle of exp.contains ?? []) {
			expect(recovered!.text).toContain(needle);
		}
	} else {
		expect(recovered).toBeNull();
	}
}

/** Point-path tool: reports a single `path` arg, matching read/write extraction. */
function pointPathTool(): { filesystemTargets: (args: unknown) => string[] } {
	return {
		filesystemTargets: (args: unknown) => {
			const a = args as { path?: unknown } | null;
			return typeof a?.path === "string" ? [a.path] : [];
		},
	};
}

function runCwdEscaping(c: CorpusCase): void {
	const input = c.input as { cwd: string; mode: "point" | "search"; args: unknown };
	const tool = input.mode === "search" ? { filesystemTargets: searchPathFilesystemTargets } : pointPathTool();
	const escaping = cwdEscapingTargets(tool, input.args, input.cwd);
	const exp = c.expect as { escaping: string[] };
	expect(escaping).toEqual(exp.escaping);
}

function runSearchPathTargets(c: CorpusCase): void {
	const targets = searchPathFilesystemTargets(c.input);
	const exp = c.expect as { targets: string[] };
	expect(targets).toEqual(exp.targets);
}

function runPathWithinCwd(c: CorpusCase): void {
	const input = c.input as { resolved: string; cwd: string };
	const exp = c.expect as { within: boolean };
	expect(isPathWithinCwd(input.resolved, input.cwd)).toBe(exp.within);
}

function runResolveToCwd(c: CorpusCase): void {
	const input = c.input as { path: string; cwd: string };
	const exp = c.expect as { resolved: string };
	expect(resolveToCwd(input.path, input.cwd)).toBe(exp.resolved);
}

function runGlobSearchBase(c: CorpusCase): void {
	const input = c.input as { pattern: string };
	const exp = c.expect as { base: string };
	expect(globSearchBase(input.pattern)).toBe(exp.base);
}

function runNormalizeRoots(c: CorpusCase): void {
	const input = c.input as { roots: string[] };
	const exp = c.expect as { roots: string[] };
	expect(normalizeRoots(input.roots)).toEqual(exp.roots);
}

function runCwdBoundaryReason(c: CorpusCase): void {
	const input = c.input as { cwd: string; escaping: string[] };
	const exp = c.expect as { text: string };
	expect(formatCwdBoundaryReason(input.cwd, input.escaping)).toBe(exp.text);
}

function runParsePrUrl(c: CorpusCase): void {
	const input = c.input as { url?: string };
	expect(parsePrUrl(input.url) as unknown).toEqual(c.expect);
}

function runParseIssueUrl(c: CorpusCase): void {
	const input = c.input as { url?: string };
	expect(parseIssueUrl(input.url) as unknown).toEqual(c.expect);
}

function runClampTimeout(c: CorpusCase): void {
	const input = c.input as { tool: ToolWithTimeout; rawTimeout?: number };
	const exp = c.expect as { seconds: number };
	expect(clampTimeout(input.tool, input.rawTimeout)).toBe(exp.seconds);
}

function runTimeoutClampNotice(c: CorpusCase): void {
	const input = c.input as {
		tool: ToolWithTimeout;
		requestedSec?: number;
		effectiveSec: number;
	};
	const exp = c.expect as { notice: string | null };
	expect(nullishToNull(formatTimeoutClampNotice(input.tool, input.requestedSec, input.effectiveSec))).toBe(exp.notice);
}

function runTimeoutParamDesc(c: CorpusCase): void {
	const input = c.input as { tool: ToolWithTimeout; zeroDisablesNoun?: string };
	const exp = c.expect as { text: string };
	expect(
		describeTimeoutParam(
			input.tool,
			input.zeroDisablesNoun ? { zeroDisablesNoun: input.zeroDisablesNoun } : undefined,
		),
	).toBe(exp.text);
}

function runParseCompactArgs(c: CorpusCase): void {
	const input = c.input as { args: string };
	expect(parseCompactArgs(input.args) as unknown).toEqual(c.expect);
}

function runFindCompactMode(c: CorpusCase): void {
	const input = c.input as { name: string };
	const exp = c.expect as { name: string | null };
	expect(nullishToNull(findCompactMode(input.name)?.name)).toBe(exp.name);
}

function runParseLineRangeChunk(c: CorpusCase): void {
	const input = c.input as { sel: string };
	const exp = c.expect as {
		throws: boolean;
		errorContains?: string;
		range?: { startLine: number; endLine?: number } | null;
	};
	let threw: Error | null = null;
	let range: ReturnType<typeof parseLineRangeChunk> | undefined;
	try {
		range = parseLineRangeChunk(input.sel);
	} catch (e) {
		threw = e as Error;
	}
	if (exp.throws) {
		expect(threw).not.toBeNull();
		if (exp.errorContains) {
			expect(String(threw?.message ?? "").toLowerCase()).toContain(exp.errorContains.toLowerCase());
		}
		return;
	}
	expect(threw).toBeNull();
	expect((range ?? null) as unknown).toEqual(exp.range ?? null);
}

function runParseLineRanges(c: CorpusCase): void {
	const input = c.input as { sel: string };
	const exp = c.expect as { ranges: Array<{ startLine: number; endLine?: number }> | null };
	expect(parseLineRanges(input.sel) as unknown).toEqual(exp.ranges);
}

function runWriteFilesystemTargets(c: CorpusCase): void {
	const input = c.input as { args: unknown };
	const exp = c.expect as { targets: string[] };
	expect(writeFilesystemTargets(input.args)).toEqual(exp.targets);
}

function runFormatPathRelative(c: CorpusCase): void {
	const input = c.input as { filePath: string; cwd: string };
	const exp = c.expect as { text: string };
	expect(formatPathRelativeToCwd(input.filePath, input.cwd)).toBe(exp.text);
}

function runParseSearchPath(c: CorpusCase): void {
	expect(parseSearchPath((c.input as { path: string }).path) as unknown).toEqual(c.expect);
}

function runParseFindPattern(c: CorpusCase): void {
	expect(parseFindPattern((c.input as { pattern: string }).pattern) as unknown).toEqual(c.expect);
}

function runRpcSuccessBuilder(c: CorpusCase): void {
	const input = c.input as { id?: string; command: "get_state" | "abort"; data: unknown };
	const exp = c.expect as {
		id: string | null;
		type: string;
		command: string;
		success: boolean;
		data: unknown;
	};
	const frame = rpcSuccessResponse(input.id, input.command, input.data as never);
	expect(nullishToNull(frame.id)).toBe(exp.id);
	expect(frame.type).toBe<string>(exp.type);
	expect(frame.command).toBe(exp.command);
	expect(frame.success).toBe(exp.success);
	expect((frame as { data?: unknown }).data).toEqual(exp.data);
}

function runRpcErrorBuilder(c: CorpusCase): void {
	const input = c.input as { id?: string; command: string; message: string };
	const frame = rpcErrorResponse(input.id, input.command, input.message);
	const exp = c.expect as {
		id: string | null;
		type: string;
		command: string;
		success: boolean;
		error: string;
	};
	expect(nullishToNull(frame.id)).toBe(exp.id);
	expect(frame.type).toBe<string>(exp.type);
	expect(frame.command).toBe(exp.command);
	expect(frame.success).toBe(exp.success);
	expect((frame as { error?: unknown }).error).toBe(exp.error);
}

function runRpcUnknownBuilder(c: CorpusCase): void {
	const input = c.input as { commandType: string };
	const frame = rpcUnknownCommandResponse(input.commandType);
	const exp = c.expect as {
		id: string | null;
		type: string;
		command: string;
		success: boolean;
		error: string;
	};
	expect(nullishToNull(frame.id)).toBe(exp.id);
	expect(frame.type).toBe<string>(exp.type);
	expect(frame.command).toBe(exp.command);
	expect(frame.success).toBe(exp.success);
	expect((frame as { error?: unknown }).error).toBe(exp.error);
}

function runFormatShortSha(c: CorpusCase): void {
	const input = c.input as { value?: string };
	const exp = c.expect as { text: string | null };
	expect(nullishToNull(formatShortSha(input.value))).toBe(exp.text);
}

function runParsePositiveDecimalInt(c: CorpusCase): void {
	const input = c.input as { value?: string };
	const exp = c.expect as { value: number | null };
	expect(nullishToNull(parsePositiveDecimalInt(input.value))).toBe(exp.value);
}

function runResolveTailLimit(c: CorpusCase): void {
	const input = c.input as { value?: number };
	const exp = c.expect as { value?: number; throws: boolean; errorContains?: string };
	let threw: Error | null = null;
	let value: number | undefined;
	try {
		value = resolveTailLimit(input.value);
	} catch (e) {
		threw = e as Error;
	}
	if (exp.throws) {
		expect(threw).not.toBeNull();
		if (exp.errorContains) {
			expect(String(threw?.message ?? "").toLowerCase()).toContain(exp.errorContains.toLowerCase());
		}
		return;
	}
	expect(threw).toBeNull();
	expect(value).toBe(exp.value);
}

function runParseConflictUri(c: CorpusCase): void {
	const input = c.input as { uri: string };
	const exp = c.expect as {
		throws: boolean;
		errorContains?: string;
		parsed?: unknown;
	};
	let threw: Error | null = null;
	let parsed: unknown;
	try {
		parsed = parseConflictUri(input.uri);
	} catch (e) {
		threw = e as Error;
	}
	if (exp.throws) {
		expect(threw).not.toBeNull();
		if (exp.errorContains) {
			expect(String(threw?.message ?? "")).toContain(exp.errorContains);
		}
		return;
	}
	expect(threw).toBeNull();
	expect(parsed ?? null).toEqual(exp.parsed ?? null);
}

function runScanConflictLines(c: CorpusCase): void {
	const input = c.input as { lines: string[]; firstLineNumber: number };
	const exp = c.expect as { blocks: unknown[] };
	expect(scanConflictLines(input.lines, input.firstLineNumber) as unknown).toEqual(exp.blocks);
}

function runIsFindingPriority(c: CorpusCase): void {
	const input = c.input as { value: unknown };
	const exp = c.expect as { ok: boolean };
	expect(isFindingPriority(input.value)).toBe(exp.ok);
}

function runGetPriorityInfo(c: CorpusCase): void {
	const input = c.input as { priority: FindingPriority };
	expect(getPriorityInfo(input.priority) as unknown).toEqual(c.expect);
}

function runTitleSlotRoundtrip(c: CorpusCase): void {
	const input = c.input as { title: string; source: "user" | "auto"; updatedAt: string };
	const exp = c.expect as {
		byteLength: number;
		title: string;
		source: string;
		updatedAt: string;
		padLength: number;
	};
	const line = serializeTitleSlot(input);
	expect(Buffer.byteLength(line, "utf-8")).toBe(exp.byteLength);
	const slot = parseTitleSlotLine(line);
	expect(slot?.title).toBe(exp.title);
	expect(slot?.source as unknown).toBe(exp.source);
	expect(slot?.updatedAt).toBe(exp.updatedAt);
	expect(slot?.pad.length).toBe(exp.padLength);
	expect(titleUpdateFromSlot(slot) as unknown).toEqual({
		title: exp.title,
		source: exp.source,
		updatedAt: exp.updatedAt,
	});
}

function runParseTitleSlotLine(c: CorpusCase): void {
	const input = c.input as { line: string };
	const exp = c.expect as { title: string | null };
	expect(nullishToNull(parseTitleSlotLine(input.line)?.title)).toBe(exp.title);
}

function runAstEditFilesystemTargets(c: CorpusCase): void {
	const input = c.input as { args: unknown };
	const exp = c.expect as { targets: string[] };
	expect(astEditFilesystemTargets(input.args)).toEqual(exp.targets);
}

function runNormalizeWindowsDrive(c: CorpusCase): void {
	const input = c.input as { filePath: string; platform: NodeJS.Platform };
	const exp = c.expect as { path: string };
	expect(normalizeWindowsDriveAliasPath(input.filePath, input.platform)).toBe(exp.path);
}

function runNormalizeLocalScheme(c: CorpusCase): void {
	const input = c.input as { filePath: string };
	const exp = c.expect as { path: string };
	expect(normalizeLocalScheme(input.filePath)).toBe(exp.path);
}

function runFormatMediaDuration(c: CorpusCase): void {
	const input = c.input as { seconds: number };
	const exp = c.expect as { text: string };
	expect(formatMediaDuration(input.seconds)).toBe(exp.text);
}

function runFormatIsoDate(c: CorpusCase): void {
	const input = c.input as { value?: string };
	const exp = c.expect as { text: string };
	expect(formatIsoDate(input.value)).toBe(exp.text);
}

function runFormatFullOutputRef(c: CorpusCase): void {
	const input = c.input as { artifactId: string };
	const exp = c.expect as { text: string };
	expect(formatFullOutputReference(input.artifactId)).toBe(exp.text);
}

function runStripRawOutputArtifact(c: CorpusCase): void {
	const input = c.input as { text: string };
	expect(stripRawOutputArtifactNotice(input.text) as unknown).toEqual(c.expect);
}

function runStripGeneratedOutputNotice(c: CorpusCase): void {
	const input = c.input as { text: string };
	const exp = c.expect as { text: string };
	expect(stripGeneratedOutputNotice(input.text)).toBe(exp.text);
}

function runFormatTruncationMetaNotice(c: CorpusCase): void {
	const input = c.input as { truncation: TruncationMeta };
	const exp = c.expect as { text: string };
	expect(formatTruncationMetaNotice(input.truncation)).toBe(exp.text);
}

function runIsWaitingPollDetails(c: CorpusCase): void {
	const input = c.input as { details: unknown };
	const exp = c.expect as { waiting: boolean };
	expect(isWaitingPollDetails(input.details)).toBe(exp.waiting);
}

function runShouldEvaluateCodexAutoRedeem(c: CorpusCase): void {
	const input = c.input as { mode: CodexAutoRedeemMode };
	const exp = c.expect as { ok: boolean };
	expect(shouldEvaluateCodexAutoRedeem(input.mode)).toBe(exp.ok);
}

function runShouldPromptCodexAutoRedeem(c: CorpusCase): void {
	const input = c.input as { mode: CodexAutoRedeemMode };
	const exp = c.expect as { ok: boolean };
	expect(shouldPromptCodexAutoRedeem(input.mode)).toBe(exp.ok);
}

function runEvaluateCodexAutoRedeem(c: CorpusCase): void {
	const input = c.input as Omit<CodexAutoRedeemInput, "attemptedBlockKeys" | "lastAttemptAtByAccount">;
	const frame = evaluateCodexAutoRedeem({
		...input,
		attemptedBlockKeys: new Set(),
		lastAttemptAtByAccount: new Map(),
	});
	expect(frame as unknown).toEqual(c.expect);
}

function runParseNumstat(c: CorpusCase): void {
	const input = c.input as { output: string };
	const exp = c.expect as { entries: unknown[] };
	expect(parseNumstat(input.output) as unknown).toEqual(exp.entries);
}

function runExtractPathFromRename(c: CorpusCase): void {
	const input = c.input as { pathPart: string };
	const exp = c.expect as { path: string };
	expect(extractPathFromRename(input.pathPart)).toBe(exp.path);
}

function runParseFileDiffs(c: CorpusCase): void {
	const input = c.input as { diff: string };
	const exp = c.expect as {
		files: Array<{ filename: string; additions: number; deletions: number; isBinary: boolean }>;
	};
	expect(
		parseFileDiffs(input.diff).map(f => ({
			filename: f.filename,
			additions: f.additions,
			deletions: f.deletions,
			isBinary: f.isBinary,
		})),
	).toEqual(exp.files);
}

function runParseUnreleasedSection(c: CorpusCase): void {
	const input = c.input as { content: string };
	const exp = c.expect as { throws: boolean; errorContains?: string; section?: unknown };
	let threw: Error | null = null;
	let section: unknown;
	try {
		section = parseUnreleasedSection(input.content);
	} catch (e) {
		threw = e as Error;
	}
	if (exp.throws) {
		expect(threw).not.toBeNull();
		if (exp.errorContains) {
			expect(String(threw?.message ?? "")).toContain(exp.errorContains);
		}
		return;
	}
	expect(threw).toBeNull();
	expect(section).toEqual(exp.section);
}

function runFormatShakeSummary(c: CorpusCase): void {
	const input = c.input as { result: ShakeResult };
	const exp = c.expect as { text: string };
	expect(formatShakeSummary(input.result)).toBe(exp.text);
}

function runCombineSearchGlobs(c: CorpusCase): void {
	const input = c.input as { prefixGlob?: string; suffixGlob?: string };
	const exp = c.expect as { glob: string | null };
	expect(nullishToNull(combineSearchGlobs(input.prefixGlob, input.suffixGlob))).toBe(exp.glob);
}

function runExpandPath(c: CorpusCase): void {
	const input = c.input as { filePath: string };
	const exp = c.expect as { path: string };
	expect(expandPath(input.filePath)).toBe(exp.path);
}

function runParseGalleryStates(c: CorpusCase): void {
	const input = c.input as { states?: string[] };
	const exp = c.expect as { throws: boolean; errorContains?: string; states?: string[] | null };
	let threw: Error | null = null;
	let states: ReturnType<typeof parseGalleryStates>;
	try {
		states = parseGalleryStates(input.states);
	} catch (e) {
		threw = e as Error;
	}
	if (exp.throws) {
		expect(threw).not.toBeNull();
		if (exp.errorContains) {
			expect(String(threw?.message ?? "")).toContain(exp.errorContains);
		}
		return;
	}
	expect(threw).toBeNull();
	expect(nullishToNull(states)).toEqual(exp.states ?? null);
}

function runParseJsonPayload(c: CorpusCase): void {
	const input = c.input as { text: string };
	const exp = c.expect as { throws: boolean; errorContains?: string; value?: unknown };
	let threw: Error | null = null;
	let value: unknown;
	try {
		value = parseJsonPayload(input.text);
	} catch (e) {
		threw = e as Error;
	}
	if (exp.throws) {
		expect(threw).not.toBeNull();
		if (exp.errorContains) {
			expect(String(threw?.message ?? "")).toContain(exp.errorContains);
		}
		return;
	}
	expect(threw).toBeNull();
	expect(value).toEqual(exp.value);
}

function runParseSearchDateBound(c: CorpusCase): void {
	const input = c.input as { raw: string; now: string };
	const exp = c.expect as { throws: boolean; errorContains?: string; value?: string };
	let threw: Error | null = null;
	let value: string | undefined;
	try {
		value = parseSearchDateBound(input.raw, new Date(input.now));
	} catch (e) {
		threw = e as Error;
	}
	if (exp.throws) {
		expect(threw).not.toBeNull();
		if (exp.errorContains) {
			expect(String(threw?.message ?? "").toLowerCase()).toContain(exp.errorContains.toLowerCase());
		}
		return;
	}
	expect(threw).toBeNull();
	expect(value).toBe(exp.value);
}

function runBuildSearchDateQualifier(c: CorpusCase): void {
	const input = c.input as {
		field: string;
		since?: string;
		until?: string;
		now: string;
	};
	const exp = c.expect as { qualifier: string | null };
	expect(nullishToNull(buildSearchDateQualifier(input.field, input.since, input.until, new Date(input.now)))).toBe(
		exp.qualifier,
	);
}

function runDetectLanguageId(c: CorpusCase): void {
	const input = c.input as { filePath: string };
	const exp = c.expect as { id: string };
	expect(detectLanguageId(input.filePath)).toBe(exp.id);
}

function runPlanModeEnforce(c: CorpusCase): void {
	const input = c.input as {
		planEnabled: boolean;
		target: string;
		op?: "create" | "update" | "delete";
		move?: string;
		artifactsDir?: string;
	};
	const exp = c.expect as { throws: boolean; errorContains?: string };
	const artifactsDir = path.join(import.meta.dir, ".corpus-artifacts");
	fs.mkdirSync(path.join(artifactsDir, "local"), { recursive: true });
	const session = makeToolSession({
		cwd: path.join(import.meta.dir, ".corpus-project"),
		getArtifactsDir: () => artifactsDir,
		getSessionId: () => "corpus-plan",
		getPlanModeState: () =>
			input.planEnabled ? { enabled: true, planFilePath: "local://plan.md" } : { enabled: false },
	});
	fs.mkdirSync(session.cwd, { recursive: true });
	let threw: Error | null = null;
	try {
		enforcePlanModeWrite(session, input.target, {
			op: input.op,
			move: input.move,
		});
	} catch (e) {
		threw = e as Error;
	}
	if (exp.throws) {
		expect(threw).not.toBeNull();
		if (exp.errorContains) {
			expect(String(threw?.message ?? "").toLowerCase()).toContain(exp.errorContains.toLowerCase());
		}
	} else {
		expect(threw).toBeNull();
	}
}

async function runCase(c: CorpusCase): Promise<void> {
	switch (c.surface) {
		case "list-limit":
			runListLimit(c);
			return;
		case "match-line-format":
			runMatchLine(c);
			return;
		case "unwrap-hashline-header":
			runUnwrap(c);
			return;
		case "hashline-apply":
			await runHashlineApply(c);
			return;
		case "rpc-parse-frame":
			await runRpcParse(c);
			return;
		case "rpc-unknown-command":
			await runRpcUnknown(c);
			return;
		case "rpc-known-get-state":
			await runRpcGetState(c);
			return;
		case "resolve-approval":
			runResolveApproval(c);
			return;
		case "plan-mode-enforce":
			runPlanModeEnforce(c);
			return;
		case "settings-get-default":
			runSettingsGetDefault(c);
			return;
		case "settings-override":
			runSettingsOverride(c);
			return;
		case "settings-path-exists":
			runSettingsPathExists(c);
			return;
		case "hashline-recovery":
			runHashlineRecovery(c);
			return;
		case "mcp-tool-name":
			runMcpToolName(c);
			return;
		case "cwd-escaping":
			runCwdEscaping(c);
			return;
		case "search-path-targets":
			runSearchPathTargets(c);
			return;
		case "path-within-cwd":
			runPathWithinCwd(c);
			return;
		case "resolve-to-cwd":
			runResolveToCwd(c);
			return;
		case "glob-search-base":
			runGlobSearchBase(c);
			return;
		case "normalize-roots":
			runNormalizeRoots(c);
			return;
		case "cwd-boundary-reason":
			runCwdBoundaryReason(c);
			return;
		case "parse-pr-url":
			runParsePrUrl(c);
			return;
		case "parse-issue-url":
			runParseIssueUrl(c);
			return;
		case "clamp-timeout":
			runClampTimeout(c);
			return;
		case "timeout-clamp-notice":
			runTimeoutClampNotice(c);
			return;
		case "timeout-param-desc":
			runTimeoutParamDesc(c);
			return;
		case "parse-compact-args":
			runParseCompactArgs(c);
			return;
		case "find-compact-mode":
			runFindCompactMode(c);
			return;
		case "parse-line-range-chunk":
			runParseLineRangeChunk(c);
			return;
		case "parse-line-ranges":
			runParseLineRanges(c);
			return;
		case "write-filesystem-targets":
			runWriteFilesystemTargets(c);
			return;
		case "format-path-relative":
			runFormatPathRelative(c);
			return;
		case "parse-search-path":
			runParseSearchPath(c);
			return;
		case "parse-find-pattern":
			runParseFindPattern(c);
			return;
		case "rpc-success-builder":
			runRpcSuccessBuilder(c);
			return;
		case "rpc-error-builder":
			runRpcErrorBuilder(c);
			return;
		case "rpc-unknown-builder":
			runRpcUnknownBuilder(c);
			return;
		case "format-short-sha":
			runFormatShortSha(c);
			return;
		case "parse-positive-decimal-int":
			runParsePositiveDecimalInt(c);
			return;
		case "resolve-tail-limit":
			runResolveTailLimit(c);
			return;
		case "parse-conflict-uri":
			runParseConflictUri(c);
			return;
		case "scan-conflict-lines":
			runScanConflictLines(c);
			return;
		case "is-finding-priority":
			runIsFindingPriority(c);
			return;
		case "get-priority-info":
			runGetPriorityInfo(c);
			return;
		case "title-slot-roundtrip":
			runTitleSlotRoundtrip(c);
			return;
		case "parse-title-slot-line":
			runParseTitleSlotLine(c);
			return;
		case "ast-edit-filesystem-targets":
			runAstEditFilesystemTargets(c);
			return;
		case "normalize-windows-drive":
			runNormalizeWindowsDrive(c);
			return;
		case "normalize-local-scheme":
			runNormalizeLocalScheme(c);
			return;
		case "format-media-duration":
			runFormatMediaDuration(c);
			return;
		case "format-iso-date":
			runFormatIsoDate(c);
			return;
		case "format-full-output-ref":
			runFormatFullOutputRef(c);
			return;
		case "strip-raw-output-artifact":
			runStripRawOutputArtifact(c);
			return;
		case "strip-generated-output-notice":
			runStripGeneratedOutputNotice(c);
			return;
		case "format-truncation-meta-notice":
			runFormatTruncationMetaNotice(c);
			return;
		case "is-waiting-poll-details":
			runIsWaitingPollDetails(c);
			return;
		case "should-evaluate-codex-auto-redeem":
			runShouldEvaluateCodexAutoRedeem(c);
			return;
		case "should-prompt-codex-auto-redeem":
			runShouldPromptCodexAutoRedeem(c);
			return;
		case "evaluate-codex-auto-redeem":
			runEvaluateCodexAutoRedeem(c);
			return;
		case "parse-numstat":
			runParseNumstat(c);
			return;
		case "extract-path-from-rename":
			runExtractPathFromRename(c);
			return;
		case "parse-file-diffs":
			runParseFileDiffs(c);
			return;
		case "parse-unreleased-section":
			runParseUnreleasedSection(c);
			return;
		case "format-shake-summary":
			runFormatShakeSummary(c);
			return;
		case "combine-search-globs":
			runCombineSearchGlobs(c);
			return;
		case "expand-path":
			runExpandPath(c);
			return;
		case "parse-gallery-states":
			runParseGalleryStates(c);
			return;
		case "parse-json-payload":
			runParseJsonPayload(c);
			return;
		case "parse-search-date-bound":
			runParseSearchDateBound(c);
			return;
		case "build-search-date-qualifier":
			runBuildSearchDateQualifier(c);
			return;
		case "detect-language-id":
			runDetectLanguageId(c);
			return;
		default:
			throw new Error(`No runner for surface ${c.surface} (case ${c.id}). Add a handler or fix the corpus.`);
	}
}

describe("regression corpus loader", () => {
	it("rejects a shape-only row missing expect (contract text is valid)", () => {
		// Contract is long enough so validation reaches the expect gate.
		const tmp = path.join(import.meta.dir, `.tmp-invalid-${Date.now()}.json`);
		fs.writeFileSync(
			tmp,
			JSON.stringify({
				cases: [
					{
						id: "missing-expect-row",
						contract: "A real one-sentence product contract for the theater gate",
						surface: "list-limit",
						input: { items: [], options: {} },
					},
				],
			}),
		);
		try {
			expect(() => loadCorpusFile(tmp)).toThrow(/expect is required/);
		} finally {
			fs.unlinkSync(tmp);
		}
	});

	it("rejects a row with a too-short contract text", () => {
		const tmp = path.join(import.meta.dir, `.tmp-short-${Date.now()}.json`);
		fs.writeFileSync(
			tmp,
			JSON.stringify({
				cases: [
					{
						id: "short-contract",
						contract: "too short",
						surface: "list-limit",
						input: {},
						expect: {},
					},
				],
			}),
		);
		try {
			expect(() => loadCorpusFile(tmp)).toThrow(/contract must be a real/);
		} finally {
			fs.unlinkSync(tmp);
		}
	});

	it("loads every regressions/*.json pack with unique ids", () => {
		const all = flattenCorpus(CORPUS_DIR, false);
		expect(all.length).toBeGreaterThanOrEqual(15);
		const ids = all.map(c => c.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const c of all) {
			expect(c.contract.length).toBeGreaterThanOrEqual(12);
			expect(c.surface.length).toBeGreaterThan(0);
			expect(c.expect).toBeDefined();
		}
	});
});

describe("regression corpus runner (shipped APIs)", () => {
	const all = flattenCorpus(CORPUS_DIR, false);

	it("has at least one adversarial-tagged case", () => {
		expect(all.some(c => c.tags?.includes("adversarial"))).toBe(true);
	});

	it("has at least one negative-tagged case", () => {
		expect(all.some(c => c.tags?.includes("negative"))).toBe(true);
	});

	for (const c of all) {
		it(`${c.surface}: ${c.id} — ${c.contract}`, async () => {
			await runCase(c);
		});
	}
});
