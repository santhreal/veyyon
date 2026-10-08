import * as fs from "node:fs/promises";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@veyyon/agent-core";
import type { ToolExample } from "@veyyon/ai";
import { type } from "@veyyon/ai/utils/schema/arktype";
import { isEnoent, lazy, prompt } from "@veyyon/utils";
import type {
	DapBreakpointRecord,
	DapCapabilities,
	DapContinueOutcome,
	DapDataBreakpointInfoResponse,
	DapDataBreakpointRecord,
	DapDisassembledInstruction,
	DapEvaluateArguments,
	DapEvaluateResponse,
	DapFunctionBreakpointRecord,
	DapInstructionBreakpointRecord,
	DapModule,
	DapResolvedAdapter,
	DapScope,
	DapSessionManager,
	DapSessionSummary,
	DapSource,
	DapStackFrame,
	DapThread,
	DapVariable,
	LaunchProgramKind,
} from "../../debug/dap";
import {
	getAdapterConfigs,
	getAvailableAdapters,
	hasAvailableAdapter,
	resolveLaunchOverrides,
	selectAttachAdapter,
	selectLaunchAdapter,
} from "../../debug/dap/config";
import { formatLocation, formatSessionSnapshot } from "../../debug/session-snapshot";
import { toolsPrompts } from "../../prompts/tools/rows";
import { scopedTimeoutSignal } from "../../utils/fetch-timeout";
import type { ToolSession } from "..";
import { truncateForPrompt } from "../core/approval";
import type { OutputMeta } from "../core/output-meta";
import { formatPathRelativeToCwd, resolveToCwd } from "../core/path-utils";
import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../core/render-utils";
import { ToolError } from "../core/tool-errors";
import { prependResultNotice, toolResult } from "../core/tool-result";
import { clampTimeout, describeTimeoutParam, formatTimeoutClampNotice } from "../core/tool-timeouts";
import { debugToolView } from "./debug-view";

/**
 * DAP debug actions that only read program state (no mutation, no execution).
 * Execution-side actions (`launch`, `attach`, `continue`, `step_*`, `pause`,
 * `evaluate`, breakpoint mutations, memory writes) are exec-tier.
 */
export const DEBUG_READONLY_ACTIONS: ReadonlySet<string> = new Set([
	"output",
	"threads",
	"stack_trace",
	"scopes",
	"variables",
	"disassemble",
	"read_memory",
	"loaded_sources",
	"modules",
	"sessions",
]);
const debugActionSchema = lazy(() =>
	type.enumerated(
		"launch",
		"attach",
		"set_breakpoint",
		"remove_breakpoint",
		"set_instruction_breakpoint",
		"remove_instruction_breakpoint",
		"data_breakpoint_info",
		"set_data_breakpoint",
		"remove_data_breakpoint",
		"continue",
		"step_over",
		"step_in",
		"step_out",
		"pause",
		"evaluate",
		"stack_trace",
		"threads",
		"scopes",
		"variables",
		"disassemble",
		"read_memory",
		"write_memory",
		"modules",
		"loaded_sources",
		"custom_request",
		"output",
		"terminate",
		"sessions",
	),
);
const debugSchema = lazy(() =>
	type({
		action: debugActionSchema.value,
		"program?": type("string").describe("debug target path; Delve accepts Go package directories"),
		"args?": type("string[]").describe("program arguments"),
		"adapter?": type("string").describe(
			"configured adapter id (gdb, lldb-dap, debugpy, dlv, rdbg, or dap.json entry)",
		),
		cwd: "string?",
		"file?": type("string").describe("source file"),
		"line?": type("number").describe("source line"),
		"function?": type("string").describe("function name"),
		"name?": type("string").describe("variable or data name"),
		"condition?": type("string").describe("breakpoint condition"),
		hit_condition: "string?",
		"expression?": type("string").describe("expression to evaluate"),
		"context?": type("string").describe("evaluate context: watch | repl | hover | variables | clipboard"),
		frame_id: "number?",
		"scope_id?": type("number").describe("scope variables reference"),
		"variable_ref?": type("number").describe("variable reference"),
		"pid?": type("number").describe("process id for attach"),
		"port?": type("number").describe("remote attach port"),
		"host?": type("string").describe("remote attach host"),
		"levels?": type("number").describe("max stack frames"),
		"memory_reference?": type("string").describe("memory reference or address"),
		instruction_reference: "string?",
		instruction_count: "number?",
		instruction_offset: "number?",
		"count?": type("number").describe("bytes to read"),
		"data?": type("string").describe("base64 memory payload"),
		"data_id?": type("string").describe("data breakpoint id"),
		"access_type?": "'read' | 'write' | 'readWrite'",
		"command?": type("string").describe("custom dap request command"),
		"arguments?": type({
			"[string]": "unknown",
		}).describe("custom request arguments"),
		offset: "number?",
		resolve_symbols: "boolean?",
		allow_partial: "boolean?",
		start_module: "number?",
		module_count: "number?",
		"timeout?": type("number").describe(describeTimeoutParam("debug")),
	}),
);

export type DebugParams = typeof debugSchema.value.infer;
export type DebugAction = DebugParams["action"];

export interface DebugToolDetails {
	action: DebugAction;
	success: boolean;
	snapshot?: DapSessionSummary;
	sessions?: DapSessionSummary[];
	stackFrames?: DapStackFrame[];
	threads?: DapThread[];
	scopes?: DapScope[];
	variables?: DapVariable[];
	sources?: DapSource[];
	modules?: DapModule[];
	evaluation?: DapEvaluateResponse;
	breakpoints?: DapBreakpointRecord[];
	functionBreakpoints?: DapFunctionBreakpointRecord[];
	instructionBreakpoints?: DapInstructionBreakpointRecord[];
	dataBreakpoints?: DapDataBreakpointRecord[];
	dataBreakpointInfo?: DapDataBreakpointInfoResponse;
	disassembly?: DapDisassembledInstruction[];
	memoryAddress?: string;
	memoryData?: string;
	unreadableBytes?: number;
	bytesWritten?: number;
	customBody?: unknown;
	output?: string;
	adapter?: string;
	state?: DapContinueOutcome["state"];
	timedOut?: boolean;
	meta?: OutputMeta;
}

function formatBreakpoints(filePath: string, breakpoints: DapBreakpointRecord[]): string {
	const lines = [`Breakpoints for ${filePath}:`];
	if (breakpoints.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const breakpoint of breakpoints) {
		lines.push(
			`- line ${breakpoint.line}: ${breakpoint.verified ? "verified" : "pending"}${breakpoint.condition ? ` if ${breakpoint.condition}` : ""}${breakpoint.message ? ` (${breakpoint.message})` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatFunctionBreakpoints(breakpoints: DapFunctionBreakpointRecord[]): string {
	const lines = ["Function breakpoints:"];
	if (breakpoints.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const breakpoint of breakpoints) {
		lines.push(
			`- ${breakpoint.name}: ${breakpoint.verified ? "verified" : "pending"}${breakpoint.condition ? ` if ${breakpoint.condition}` : ""}${breakpoint.message ? ` (${breakpoint.message})` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatStackFrames(frames: DapStackFrame[]): string {
	const lines = ["Stack trace:"];
	if (frames.length === 0) {
		lines.push("(empty)");
		return lines.join("\n");
	}
	for (const frame of frames) {
		const location = frame.source?.path
			? `${frame.source.path}:${frame.line}:${frame.column}`
			: `<unknown>:${frame.line}:${frame.column}`;
		lines.push(`- #${frame.id} ${frame.name} @ ${location}`);
	}
	return lines.join("\n");
}

function formatThreads(threads: DapThread[]): string {
	const lines = ["Threads:"];
	if (threads.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const thread of threads) {
		lines.push(`- ${thread.id}: ${thread.name}`);
	}
	return lines.join("\n");
}

function formatScopes(scopes: DapScope[]): string {
	const lines = ["Scopes:"];
	if (scopes.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const scope of scopes) {
		lines.push(
			`- ${scope.name}: ref=${scope.variablesReference}, expensive=${scope.expensive ? "yes" : "no"}${scope.presentationHint ? `, hint=${scope.presentationHint}` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatVariables(variables: DapVariable[]): string {
	const lines = ["Variables:"];
	if (variables.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const variable of variables) {
		lines.push(
			`- ${variable.name} = ${variable.value}${variable.type ? ` (${variable.type})` : ""}${variable.variablesReference > 0 ? ` [ref=${variable.variablesReference}]` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatSourceLabel(source: DapSource | undefined, line?: number, column?: number): string | null {
	if (!source?.path && !source?.name) {
		return null;
	}
	const base = source.path ?? source.name ?? "<unknown>";
	if (line === undefined) {
		return base;
	}
	return `${base}:${line}${column !== undefined ? `:${column}` : ""}`;
}

function formatDisassembly(instructions: DapDisassembledInstruction[]): string {
	const lines = ["Disassembly:"];
	if (instructions.length === 0) {
		lines.push("(empty)");
		return lines.join("\n");
	}
	const addressWidth = Math.max(...instructions.map(instruction => instruction.address.length));
	const bytesWidth = Math.max(...instructions.map(instruction => instruction.instructionBytes?.length ?? 0), 2);
	for (const instruction of instructions) {
		const location = formatSourceLabel(instruction.location, instruction.line, instruction.column);
		const parts = [
			instruction.address.padEnd(addressWidth),
			(instruction.instructionBytes ?? "").padEnd(bytesWidth),
			instruction.instruction,
		];
		if (instruction.symbol) {
			parts.push(`<${instruction.symbol}>`);
		}
		if (location) {
			parts.push(`[${location}]`);
		}
		lines.push(
			parts
				.filter(part => part.length > 0)
				.join("  ")
				.trimEnd(),
		);
	}
	return lines.join("\n");
}

function formatMemoryRead(address: string, data: string | undefined, unreadableBytes?: number): string {
	const lines = [`Memory at ${address}:`];
	const buffer = data ? Buffer.from(data, "base64") : Buffer.alloc(0);
	if (buffer.length === 0) {
		lines.push("(no readable bytes)");
	} else {
		for (let offset = 0; offset < buffer.length; offset += 16) {
			const chunk = buffer.subarray(offset, offset + 16);
			const hex = Array.from(chunk, byte => byte.toString(16).padStart(2, "0")).join(" ");
			const ascii = Array.from(chunk, byte => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".")).join("");
			lines.push(
				`${(offset === 0 ? address : `+0x${offset.toString(16)}`).padEnd(18)} ${hex.padEnd(47)} |${ascii}|`,
			);
		}
	}
	if (unreadableBytes !== undefined && unreadableBytes > 0) {
		lines.push(`Unreadable bytes: ${unreadableBytes}`);
	}
	return lines.join("\n");
}

function formatTable(headers: string[], rows: string[][]): string {
	const widths = headers.map((header, index) =>
		Math.max(header.length, ...rows.map(row => (row[index] ?? "").length)),
	);
	const formatRow = (row: string[]) => row.map((cell, index) => (cell ?? "").padEnd(widths[index])).join("  ");
	return [formatRow(headers), formatRow(widths.map(width => "-".repeat(width))), ...rows.map(formatRow)].join("\n");
}

function formatModules(modules: DapModule[]): string {
	if (modules.length === 0) {
		return "Modules:\n(none)";
	}
	return [
		"Modules:",
		formatTable(
			["ID", "Name", "Path", "Symbols", "Range"],
			modules.map(module => [
				String(module.id),
				module.name,
				module.path ?? "",
				module.symbolStatus ?? "",
				module.addressRange ?? "",
			]),
		),
	].join("\n");
}

function formatLoadedSources(sources: DapSource[]): string {
	const lines = ["Loaded sources:"];
	if (sources.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const source of sources) {
		const label = source.path ?? source.name ?? "<unknown>";
		lines.push(`- ${label}${source.sourceReference !== undefined ? ` [ref=${source.sourceReference}]` : ""}`);
	}
	return lines.join("\n");
}

function formatInstructionBreakpoints(breakpoints: DapInstructionBreakpointRecord[]): string {
	const lines = ["Instruction breakpoints:"];
	if (breakpoints.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const breakpoint of breakpoints) {
		const location = `${breakpoint.instructionReference}${breakpoint.offset !== undefined ? `+${breakpoint.offset}` : ""}`;
		lines.push(
			`- ${location}: ${breakpoint.verified ? "verified" : "pending"}${breakpoint.condition ? ` if ${breakpoint.condition}` : ""}${breakpoint.hitCondition ? ` after ${breakpoint.hitCondition}` : ""}${breakpoint.message ? ` (${breakpoint.message})` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatDataBreakpointInfo(info: DapDataBreakpointInfoResponse): string {
	const lines = [`Data breakpoint info: ${info.description}`];
	lines.push(`Data ID: ${info.dataId ?? "(not available)"}`);
	if (info.accessTypes && info.accessTypes.length > 0) {
		lines.push(`Access types: ${info.accessTypes.join(", ")}`);
	}
	if (info.canPersist !== undefined) {
		lines.push(`Persistent: ${info.canPersist ? "yes" : "no"}`);
	}
	return lines.join("\n");
}

function formatDataBreakpoints(breakpoints: DapDataBreakpointRecord[]): string {
	const lines = ["Data breakpoints:"];
	if (breakpoints.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const breakpoint of breakpoints) {
		lines.push(
			`- ${breakpoint.dataId}: ${breakpoint.verified ? "verified" : "pending"}${breakpoint.accessType ? ` (${breakpoint.accessType})` : ""}${breakpoint.condition ? ` if ${breakpoint.condition}` : ""}${breakpoint.hitCondition ? ` after ${breakpoint.hitCondition}` : ""}${breakpoint.message ? ` (${breakpoint.message})` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatCustomResponse(command: string, body: unknown): string {
	let serialized = "";
	try {
		serialized = JSON.stringify(body, null, 2) ?? "null";
	} catch {
		serialized = Bun.inspect(body);
	}
	return `${command} response:\n${serialized}`;
}

function formatSessions(sessions: DapSessionSummary[]): string {
	if (sessions.length === 0) {
		return "No debug sessions.";
	}
	return sessions
		.map(session => {
			const location = formatLocation(session);
			return [
				`${session.id}: ${session.status}`,
				`  adapter=${session.adapter}`,
				`  cwd=${session.cwd}`,
				...(session.program ? [`  program=${session.program}`] : []),
				...(location ? [`  location=${location}`] : []),
				...(session.stopReason ? [`  reason=${session.stopReason}`] : []),
			].join("\n");
		})
		.join("\n\n");
}

function formatEvaluation(evaluation: DapEvaluateResponse): string {
	const lines = [`Result: ${evaluation.result}`];
	if (evaluation.type) lines.push(`Type: ${evaluation.type}`);
	if (evaluation.variablesReference > 0) {
		lines.push(`Variables ref: ${evaluation.variablesReference}`);
	}
	return lines.join("\n");
}

function buildOutcomeText(outcome: DapContinueOutcome, timeoutSec: number, verb: string): string {
	const lines = formatSessionSnapshot(outcome.snapshot);
	if (outcome.timedOut) {
		lines.push(`Program is still running after ${timeoutSec}s. Use pause to interrupt and inspect state.`);
		return lines.join("\n");
	}
	if (outcome.state === "stopped") {
		lines.push(`${verb} stopped at ${formatLocation(outcome.snapshot) ?? "unknown location"}.`);
		return lines.join("\n");
	}
	if (outcome.state === "terminated") {
		lines.push(
			`Program terminated${outcome.snapshot.exitCode !== undefined ? ` with exit code ${outcome.snapshot.exitCode}` : ""}.`,
		);
		return lines.join("\n");
	}
	lines.push("Program is running.");
	return lines.join("\n");
}

function getConfiguredAdapters(cwd: string): string {
	const adapters = getAvailableAdapters(cwd).map(adapter => adapter.name);
	const names = adapters.length > 0 ? adapters.join(", ") : "none";
	return truncateToWidth(replaceTabs(names), TRUNCATE_LENGTHS.LONG);
}

const ADAPTER_UNAVAILABLE_MESSAGES: Readonly<Record<string, string>> = {
	debugpy: "adapter 'debugpy' is not available: neither python3 nor python was found in PATH",
	dlv: "adapter 'dlv' is not available: install with 'go install github.com/go-delve/delve/cmd/dlv@latest'",
	rdbg: "adapter 'rdbg' is not available: install with 'gem install debug'",
};

const ADAPTER_CANONICAL_COMMANDS: Readonly<Record<string, string>> = {
	debugpy: "python3",
	dlv: "dlv",
	rdbg: "rdbg",
};

function formatAdapterUnavailable(adapterName: string, command: string, cwd: string): string {
	const displayName = truncateToWidth(replaceTabs(adapterName), TRUNCATE_LENGTHS.SHORT);
	const canonicalCommand = ADAPTER_CANONICAL_COMMANDS[adapterName] ?? adapterName;
	if (command !== canonicalCommand) {
		const displayCommand = truncateToWidth(replaceTabs(shortenPath(command)), TRUNCATE_LENGTHS.CONTENT);
		return `adapter '${displayName}' is not available: configured command '${displayCommand}' did not resolve. Check the DAP adapter config for this workspace.`;
	}
	return (
		ADAPTER_UNAVAILABLE_MESSAGES[adapterName] ??
		`adapter '${displayName}' is not available. Installed adapters: ${getConfiguredAdapters(cwd)}`
	);
}

async function classifyLaunchProgram(program: string): Promise<LaunchProgramKind> {
	try {
		return (await fs.stat(program)).isDirectory() ? "directory" : "file";
	} catch (error) {
		if (isEnoent(error)) return "missing";
		throw error;
	}
}

function validateLaunchProgram(
	program: string,
	cwd: string,
	programKind: LaunchProgramKind,
	adapter: DapResolvedAdapter,
): void {
	if (programKind !== "directory" || adapter.acceptsDirectoryProgram) return;
	const displayPath = formatPathRelativeToCwd(program, cwd, { trailingSlash: true });
	throw new ToolError(
		`launch program resolves to a directory: ${displayPath}. Pass an executable file path or choose an adapter that supports package directories.`,
	);
}

function getActiveSessionSnapshot(dap: DapSessionManager): DapSessionSummary {
	const snapshot = dap.getActiveSession();
	if (!snapshot) {
		throw new ToolError("No active debug session. Launch or attach first.");
	}
	return snapshot;
}

function requireCapability(
	dap: DapSessionManager,
	capability: keyof DapCapabilities,
	description: string,
): DapSessionSummary {
	const snapshot = getActiveSessionSnapshot(dap);
	if (dap.getCapabilities()?.[capability] !== true) {
		throw new ToolError(`Current adapter does not support ${description}`);
	}
	return snapshot;
}

function resolveDisassemblyReference(dap: DapSessionManager, memoryReference: string | undefined): string {
	if (memoryReference) {
		return memoryReference;
	}
	const snapshot = getActiveSessionSnapshot(dap);
	if (snapshot.instructionPointerReference) {
		return snapshot.instructionPointerReference;
	}
	throw new ToolError(
		"disassemble requires memory_reference unless the current stop location has an instruction pointer reference",
	);
}

/**
 * One debug call: the DAP session manager, its parameters, the session's cwd, the signal and budget
 * every DAP request takes, and the details its result reports.
 */
interface DebugCall {
	readonly dap: DapSessionManager;
	readonly params: DebugParams;
	readonly cwd: string;
	readonly signal: AbortSignal;
	readonly timeoutSec: number;
	readonly timeoutMs: number;
	readonly details: DebugToolDetails;
}

/** Runs one action against the DAP session manager, records what it reports in `details`, and returns the result text. */
type DebugActionRun = (call: DebugCall) => Promise<string> | string;

async function launchSession({ dap, params, cwd, signal, timeoutMs, details }: DebugCall): Promise<string> {
	if (!params.program) {
		// `program` is the thing to RUN; `file` is only a breakpoint's source
		// location. A caller that supplied `file` (thinking it names the target
		// to debug) hit a dead-end "program is required" and looped. Name the
		// field, distinguish it from `file`, and show a minimal valid call.
		const hint = params.file
			? ` You passed file: ${JSON.stringify(params.file)}. "file" only sets a breakpoint's source; it does not launch anything. To debug that path, pass it as "program": {"action":"launch","program":${JSON.stringify(params.file)}}.`
			: ` "program" is the executable, script, or package to run under the debugger, e.g. {"action":"launch","program":"src/main.py"}. "file"/"cwd" alone do not launch anything.`;
		throw new ToolError(`launch requires "program" (the target to debug).${hint}`);
	}
	const commandCwd = params.cwd ? resolveToCwd(params.cwd, cwd) : cwd;
	const program = resolveToCwd(params.program, commandCwd);
	const programKind = await classifyLaunchProgram(program);
	const selection = selectLaunchAdapter(program, commandCwd, params.adapter, programKind);
	if (selection.kind === "unavailable") {
		throw new ToolError(formatAdapterUnavailable(selection.adapterName, selection.command, commandCwd));
	}
	if (selection.kind === "none") {
		throw new ToolError(`No debugger adapter available. Installed adapters: ${getConfiguredAdapters(commandCwd)}`);
	}
	const { adapter } = selection;
	validateLaunchProgram(program, commandCwd, programKind, adapter);
	const extraLaunchArguments = resolveLaunchOverrides(adapter, program, programKind);
	const snapshot = await dap.launch(
		{ adapter, program, args: params.args, cwd: commandCwd, extraLaunchArguments },
		signal,
		timeoutMs,
	);
	details.snapshot = snapshot;
	details.adapter = adapter.name;
	return formatSessionSnapshot(snapshot).join("\n");
}

async function attachSession({ dap, params, cwd, signal, timeoutMs, details }: DebugCall): Promise<string> {
	if (params.pid === undefined && params.port === undefined) {
		throw new ToolError("attach requires pid or port");
	}
	const commandCwd = params.cwd ? resolveToCwd(params.cwd, cwd) : cwd;
	const adapter = selectAttachAdapter(commandCwd, params.adapter, params.port);
	if (!adapter) {
		if (params.adapter) {
			const command = getAdapterConfigs(commandCwd)[params.adapter]?.command ?? params.adapter;
			throw new ToolError(formatAdapterUnavailable(params.adapter, command, commandCwd));
		}
		throw new ToolError(`No debugger adapter available. Installed adapters: ${getConfiguredAdapters(commandCwd)}`);
	}
	const snapshot = await dap.attach(
		{ adapter, cwd: commandCwd, pid: params.pid, port: params.port, host: params.host },
		signal,
		timeoutMs,
	);
	details.snapshot = snapshot;
	details.adapter = adapter.name;
	return formatSessionSnapshot(snapshot).join("\n");
}

/** `continue` and the three steps: resume the program and report where it stopped, ended or kept running. */
function resumeExecution(
	verb: string,
	resume: (dap: DapSessionManager, signal: AbortSignal, timeoutMs: number) => Promise<DapContinueOutcome>,
): DebugActionRun {
	return async ({ dap, signal, timeoutSec, timeoutMs, details }) => {
		const outcome = await resume(dap, signal, timeoutMs);
		details.snapshot = outcome.snapshot;
		details.state = outcome.state;
		details.timedOut = outcome.timedOut;
		return buildOutcomeText(outcome, timeoutSec, verb);
	};
}

let dapSessions: Promise<DapSessionManager> | undefined;

/**
 * The DAP client and session manager, loaded on the first debug call. Registering the tool reads
 * only the adapter config, so a session that never debugs never compiles the protocol client.
 */
function loadDapSessions(): Promise<DapSessionManager> {
	dapSessions ??= import("../../debug/dap/session").then(module => module.dapSessionManager);
	return dapSessions;
}

/** Every action's run, one per member of `debugActionSchema`: an action without one fails the type check. */
const DEBUG_ACTIONS: { readonly [A in DebugAction]: DebugActionRun } = {
	launch: launchSession,
	attach: attachSession,
	set_breakpoint: async ({ dap, params, cwd, signal, timeoutMs, details }) => {
		if (params.function) {
			const response = await dap.setFunctionBreakpoint(params.function, params.condition, signal, timeoutMs);
			details.snapshot = response.snapshot;
			details.functionBreakpoints = response.breakpoints;
			return formatFunctionBreakpoints(response.breakpoints);
		}
		if (!params.file || params.line === undefined) {
			throw new ToolError("set_breakpoint requires file+line or function");
		}
		const file = resolveToCwd(params.file, cwd);
		const response = await dap.setBreakpoint(file, params.line, params.condition, signal, timeoutMs);
		details.snapshot = response.snapshot;
		details.breakpoints = response.breakpoints;
		return formatBreakpoints(response.sourcePath, response.breakpoints);
	},
	remove_breakpoint: async ({ dap, params, cwd, signal, timeoutMs, details }) => {
		if (params.function) {
			const response = await dap.removeFunctionBreakpoint(params.function, signal, timeoutMs);
			details.snapshot = response.snapshot;
			details.functionBreakpoints = response.breakpoints;
			return formatFunctionBreakpoints(response.breakpoints);
		}
		if (!params.file || params.line === undefined) {
			throw new ToolError("remove_breakpoint requires file+line or function");
		}
		const file = resolveToCwd(params.file, cwd);
		const response = await dap.removeBreakpoint(file, params.line, signal, timeoutMs);
		details.snapshot = response.snapshot;
		details.breakpoints = response.breakpoints;
		return formatBreakpoints(response.sourcePath, response.breakpoints);
	},
	set_instruction_breakpoint: async ({ dap, params, signal, timeoutMs, details }) => {
		requireCapability(dap, "supportsInstructionBreakpoints", "instruction breakpoints");
		if (!params.instruction_reference) {
			throw new ToolError("instruction_reference is required for set_instruction_breakpoint");
		}
		const response = await dap.setInstructionBreakpoint(
			params.instruction_reference,
			params.offset,
			params.condition,
			params.hit_condition,
			signal,
			timeoutMs,
		);
		details.snapshot = response.snapshot;
		details.instructionBreakpoints = response.breakpoints;
		return formatInstructionBreakpoints(response.breakpoints);
	},
	remove_instruction_breakpoint: async ({ dap, params, signal, timeoutMs, details }) => {
		requireCapability(dap, "supportsInstructionBreakpoints", "instruction breakpoints");
		if (!params.instruction_reference) {
			throw new ToolError("instruction_reference is required for remove_instruction_breakpoint");
		}
		const response = await dap.removeInstructionBreakpoint(
			params.instruction_reference,
			params.offset,
			signal,
			timeoutMs,
		);
		details.snapshot = response.snapshot;
		details.instructionBreakpoints = response.breakpoints;
		return formatInstructionBreakpoints(response.breakpoints);
	},
	data_breakpoint_info: async ({ dap, params, signal, timeoutMs, details }) => {
		requireCapability(dap, "supportsDataBreakpoints", "data breakpoints");
		if (!params.name) {
			throw new ToolError("name is required for data_breakpoint_info");
		}
		const response = await dap.dataBreakpointInfo(
			params.name,
			params.variable_ref ?? params.scope_id,
			params.frame_id,
			signal,
			timeoutMs,
		);
		details.snapshot = response.snapshot;
		details.dataBreakpointInfo = response.info;
		return formatDataBreakpointInfo(response.info);
	},
	set_data_breakpoint: async ({ dap, params, signal, timeoutMs, details }) => {
		requireCapability(dap, "supportsDataBreakpoints", "data breakpoints");
		if (!params.data_id) {
			throw new ToolError("data_id is required for set_data_breakpoint");
		}
		const response = await dap.setDataBreakpoint(
			params.data_id,
			params.access_type,
			params.condition,
			params.hit_condition,
			signal,
			timeoutMs,
		);
		details.snapshot = response.snapshot;
		details.dataBreakpoints = response.breakpoints;
		return formatDataBreakpoints(response.breakpoints);
	},
	remove_data_breakpoint: async ({ dap, params, signal, timeoutMs, details }) => {
		requireCapability(dap, "supportsDataBreakpoints", "data breakpoints");
		if (!params.data_id) {
			throw new ToolError("data_id is required for remove_data_breakpoint");
		}
		const response = await dap.removeDataBreakpoint(params.data_id, signal, timeoutMs);
		details.snapshot = response.snapshot;
		details.dataBreakpoints = response.breakpoints;
		return formatDataBreakpoints(response.breakpoints);
	},
	continue: resumeExecution("Continue", (dap, signal, timeoutMs) => dap.continue(signal, timeoutMs)),
	step_over: resumeExecution("Step over", (dap, signal, timeoutMs) => dap.stepOver(signal, timeoutMs)),
	step_in: resumeExecution("Step in", (dap, signal, timeoutMs) => dap.stepIn(signal, timeoutMs)),
	step_out: resumeExecution("Step out", (dap, signal, timeoutMs) => dap.stepOut(signal, timeoutMs)),
	pause: async ({ dap, signal, timeoutMs, details }) => {
		const snapshot = await dap.pause(signal, timeoutMs);
		details.snapshot = snapshot;
		return formatSessionSnapshot(snapshot).concat("Program paused.").join("\n");
	},
	evaluate: async ({ dap, params, signal, timeoutMs, details }) => {
		if (!params.expression) {
			throw new ToolError("expression is required for evaluate");
		}
		const evaluationContext = (params.context as DapEvaluateArguments["context"] | undefined) ?? "repl";
		const response = await dap.evaluate(params.expression, evaluationContext, params.frame_id, signal, timeoutMs);
		details.snapshot = response.snapshot;
		details.evaluation = response.evaluation;
		return formatEvaluation(response.evaluation);
	},
	stack_trace: async ({ dap, params, signal, timeoutMs, details }) => {
		const response = await dap.stackTrace(params.levels, signal, timeoutMs);
		details.snapshot = response.snapshot;
		details.stackFrames = response.stackFrames;
		return formatStackFrames(response.stackFrames);
	},
	threads: async ({ dap, signal, timeoutMs, details }) => {
		const response = await dap.threads(signal, timeoutMs);
		details.snapshot = response.snapshot;
		details.threads = response.threads;
		return formatThreads(response.threads);
	},
	scopes: async ({ dap, params, signal, timeoutMs, details }) => {
		const response = await dap.scopes(params.frame_id, signal, timeoutMs);
		details.snapshot = response.snapshot;
		details.scopes = response.scopes;
		return formatScopes(response.scopes);
	},
	variables: async ({ dap, params, signal, timeoutMs, details }) => {
		const variableReference = params.variable_ref ?? params.scope_id;
		if (variableReference === undefined) {
			throw new ToolError("variables requires variable_ref or scope_id");
		}
		const response = await dap.variables(variableReference, signal, timeoutMs);
		details.snapshot = response.snapshot;
		details.variables = response.variables;
		return formatVariables(response.variables);
	},
	disassemble: async ({ dap, params, signal, timeoutMs, details }) => {
		requireCapability(dap, "supportsDisassembleRequest", "disassembly");
		if (params.instruction_count === undefined) {
			throw new ToolError("instruction_count is required for disassemble");
		}
		const response = await dap.disassemble(
			resolveDisassemblyReference(dap, params.memory_reference),
			params.instruction_count,
			params.offset,
			params.instruction_offset,
			params.resolve_symbols,
			signal,
			timeoutMs,
		);
		details.snapshot = response.snapshot;
		details.disassembly = response.instructions;
		return formatDisassembly(response.instructions);
	},
	read_memory: async ({ dap, params, signal, timeoutMs, details }) => {
		requireCapability(dap, "supportsReadMemoryRequest", "memory reads");
		if (!params.memory_reference) {
			throw new ToolError("memory_reference is required for read_memory");
		}
		if (params.count === undefined) {
			throw new ToolError("count is required for read_memory");
		}
		const response = await dap.readMemory(params.memory_reference, params.count, params.offset, signal, timeoutMs);
		details.snapshot = response.snapshot;
		details.memoryAddress = response.address;
		details.memoryData = response.data;
		details.unreadableBytes = response.unreadableBytes;
		return formatMemoryRead(response.address, response.data, response.unreadableBytes);
	},
	write_memory: async ({ dap, params, signal, timeoutMs, details }) => {
		requireCapability(dap, "supportsWriteMemoryRequest", "memory writes");
		if (!params.memory_reference) {
			throw new ToolError("memory_reference is required for write_memory");
		}
		if (!params.data) {
			throw new ToolError("data is required for write_memory");
		}
		const response = await dap.writeMemory(
			params.memory_reference,
			params.data,
			params.offset,
			params.allow_partial,
			signal,
			timeoutMs,
		);
		details.snapshot = response.snapshot;
		details.bytesWritten = response.bytesWritten;
		return [
			"Memory write completed.",
			...(response.bytesWritten !== undefined ? [`Bytes written: ${response.bytesWritten}`] : []),
			...(response.offset !== undefined ? [`Offset: ${response.offset}`] : []),
		].join("\n");
	},
	modules: async ({ dap, params, signal, timeoutMs, details }) => {
		requireCapability(dap, "supportsModulesRequest", "module introspection");
		const response = await dap.modules(params.start_module, params.module_count, signal, timeoutMs);
		details.snapshot = response.snapshot;
		details.modules = response.modules;
		return formatModules(response.modules);
	},
	loaded_sources: async ({ dap, signal, timeoutMs, details }) => {
		requireCapability(dap, "supportsLoadedSourcesRequest", "loaded sources");
		const response = await dap.loadedSources(signal, timeoutMs);
		details.snapshot = response.snapshot;
		details.sources = response.sources;
		return formatLoadedSources(response.sources);
	},
	custom_request: async ({ dap, params, signal, timeoutMs, details }) => {
		if (!params.command) {
			throw new ToolError("command is required for custom_request");
		}
		const response = await dap.customRequest(params.command, params.arguments, signal, timeoutMs);
		details.snapshot = response.snapshot;
		details.customBody = response.body;
		return formatCustomResponse(params.command, response.body);
	},
	output: ({ dap, details }) => {
		const response = dap.getOutput();
		details.snapshot = response.snapshot;
		details.output = response.output;
		return response.output.length > 0 ? response.output : "(no output captured)";
	},
	terminate: async ({ dap, signal, timeoutMs, details }) => {
		const snapshot = await dap.terminate(signal, timeoutMs);
		if (!snapshot) {
			return "No debug session to terminate.";
		}
		details.snapshot = snapshot;
		return formatSessionSnapshot(snapshot).concat("Debug session terminated.").join("\n");
	},
	sessions: ({ dap, details }) => {
		const sessions = dap.listSessions();
		details.sessions = sessions;
		return formatSessions(sessions);
	},
};

export class DebugTool implements AgentTool<typeof debugSchema.value, DebugToolDetails> {
	readonly name = "debug";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const rawAction = (args as Partial<DebugParams>).action;
		const action = typeof rawAction === "string" ? rawAction.toLowerCase() : "";
		return DEBUG_READONLY_ACTIONS.has(action) ? "read" : "exec";
	};
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<DebugParams>;
		const lines = [`Action: ${typeof params.action === "string" ? params.action : "(missing)"}`];
		if (typeof params.program === "string" && params.program.length > 0) {
			lines.push(`Program: ${truncateForPrompt(params.program)}`);
		}
		return lines;
	};
	readonly label = "Debug";
	readonly summary = "Debug a running process with DAP (debugger adapter protocol)";
	readonly description: string;
	get parameters(): typeof debugSchema.value {
		return debugSchema.value;
	}
	readonly strict = true;
	readonly view = debugToolView;

	readonly examples: readonly ToolExample<typeof debugSchema.value.infer>[] = [
		{
			caption: "Launch and inspect hang",
			note: '1. debug(action: "launch", program: "./my_app")\n2. debug(action: "set_breakpoint", file: "src/main.c", line: 42)\n3. debug(action: "continue")\n4. If the program appears hung: debug(action: "pause")\n5. Inspect state with `threads`, `stack_trace`, `scopes`, and `variables`',
		},
		{
			caption: "Launch a Python script with debugpy",
			call: { action: "launch", adapter: "debugpy", program: "scripts/job.py", args: ["--flag"] },
		},
	];

	readonly concurrency = "exclusive";
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(toolsPrompts["tools/debug"].text);
	}

	/**
	 * A debugger the host cannot start is not worth its schema on every request. The description
	 * and parameters cost about 1,000 tokens of every request, and every call would fail on the
	 * missing adapter command, so the tool loads only where at least one configured adapter
	 * resolves. `ssh` drops itself the same way when no host is configured.
	 */
	static createIf(session: ToolSession): DebugTool | null {
		if (!session.settings.get("debug.enabled")) return null;
		if (!hasAvailableAdapter(session.cwd)) return null;
		return new DebugTool(session);
	}

	async execute(
		_toolCallId: string,
		params: DebugParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<DebugToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<DebugToolDetails>> {
		const timeoutSec = clampTimeout("debug", params.timeout, this.session.settings.get("tools.maxTimeout"));
		// A clamp changes the budget the agent asked for; surface it on the result
		// rather than applying it silently (Law 10). Debug actions each build their
		// own result, so prepend the notice here in the one shared wrapper.
		const clampNotice = formatTimeoutClampNotice("debug", params.timeout, timeoutSec);
		const timeout = scopedTimeoutSignal(timeoutSec * 1000, signal);
		try {
			const result = await this.#executeWithSignal(params, timeout.signal, timeoutSec);
			return clampNotice ? prependResultNotice(result, clampNotice) : result;
		} finally {
			timeout.cancel();
		}
	}

	async #executeWithSignal(
		params: DebugParams,
		combinedSignal: AbortSignal,
		timeoutSec: number,
	): Promise<AgentToolResult<DebugToolDetails>> {
		if (!Object.hasOwn(DEBUG_ACTIONS, params.action)) {
			throw new ToolError(`Unsupported debug action: ${params.action}`);
		}
		const details: DebugToolDetails = { action: params.action, success: true };
		const text = await DEBUG_ACTIONS[params.action]({
			dap: await loadDapSessions(),
			params,
			cwd: this.session.cwd,
			signal: combinedSignal,
			timeoutSec,
			timeoutMs: timeoutSec * 1000,
			details,
		});
		return toolResult(details).text(text).done();
	}
}
