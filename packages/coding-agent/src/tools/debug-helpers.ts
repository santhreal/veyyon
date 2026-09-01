import * as fs from "node:fs/promises";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { type Component, Text } from "@veyyon/tui";
import { formatMoreLines, isEnoent } from "@veyyon/utils";
import { type } from "arktype";
import {
	type DapBreakpointRecord,
	type DapCapabilities,
	type DapContinueOutcome,
	type DapDataBreakpointInfoResponse,
	type DapDataBreakpointRecord,
	type DapDisassembledInstruction,
	type DapEvaluateResponse,
	type DapFunctionBreakpointRecord,
	type DapInstructionBreakpointRecord,
	type DapModule,
	type DapResolvedAdapter,
	type DapScope,
	type DapSessionSummary,
	type DapSource,
	type DapStackFrame,
	type DapThread,
	type DapVariable,
	dapSessionManager,
	getAvailableAdapters,
	type LaunchProgramKind,
} from "../dap";
import type { Theme } from "../modes/theme/theme";
import { renderStatusLine } from "../tui";
import { CachedOutputBlock, markFramedBlockComponent } from "../tui/output-block";
import type { OutputMeta } from "./output-meta";
import { formatPathRelativeToCwd } from "./path-utils";
import {
	formatExpandHint,
	formatStatusIcon,
	PREVIEW_LIMITS,
	replaceTabs,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "./render-utils";
import { ToolError } from "./tool-errors";
import { describeTimeoutParam } from "./tool-timeouts";

/** DAP debug actions that only read program state (no mutation, no execution). Execution-side actions (`launch`, `attach`, `continue`, `step_*`, `pause`, */
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
export const debugActionSchema = type.enumerated(
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
);
export const debugSchema = type({
	action: debugActionSchema,
	"program?": type("string").describe("debug target path; Delve accepts Go package directories"),
	"args?": type("string[]").describe("program arguments"),
	"adapter?": type("string").describe("configured adapter id (gdb, lldb-dap, debugpy, dlv, rdbg, or dap.json entry)"),
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
});

export type DebugParams = typeof debugSchema.infer;
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

export function formatLocation(snapshot: DapSessionSummary | undefined): string | null {
	if (!snapshot?.source?.path || snapshot.line === undefined) {
		return null;
	}
	return `${snapshot.source.path}:${snapshot.line}${snapshot.column !== undefined ? `:${snapshot.column}` : ""}`;
}

export function formatSessionSnapshot(snapshot: DapSessionSummary): string[] {
	const lines = [
		`Session ${snapshot.id}`,
		`Adapter: ${snapshot.adapter}`,
		`Status: ${snapshot.status}`,
		`CWD: ${snapshot.cwd}`,
	];
	if (snapshot.program) lines.push(`Program: ${snapshot.program}`);
	if (snapshot.stopReason) lines.push(`Stop reason: ${snapshot.stopReason}`);
	if (snapshot.frameName) lines.push(`Frame: ${snapshot.frameName}`);
	if (snapshot.instructionPointerReference) {
		lines.push(`Instruction pointer: ${snapshot.instructionPointerReference}`);
	}
	const location = formatLocation(snapshot);
	if (location) lines.push(`Location: ${location}`);
	if (snapshot.needsConfigurationDone) {
		lines.push("Configuration: pending configurationDone; set breakpoints, then continue.");
	}
	if (snapshot.exitCode !== undefined) lines.push(`Exit code: ${snapshot.exitCode}`);
	return lines;
}

export function formatBreakpoints(filePath: string, breakpoints: DapBreakpointRecord[]): string {
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

export function formatFunctionBreakpoints(breakpoints: DapFunctionBreakpointRecord[]): string {
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

export function formatStackFrames(frames: DapStackFrame[]): string {
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

export function formatThreads(threads: DapThread[]): string {
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

export function formatScopes(scopes: DapScope[]): string {
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

export function formatVariables(variables: DapVariable[]): string {
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

export function formatSourceLabel(source: DapSource | undefined, line?: number, column?: number): string | null {
	if (!source?.path && !source?.name) {
		return null;
	}
	const base = source.path ?? source.name ?? "<unknown>";
	if (line === undefined) {
		return base;
	}
	return `${base}:${line}${column !== undefined ? `:${column}` : ""}`;
}

export function formatDisassembly(instructions: DapDisassembledInstruction[]): string {
	const lines = ["Disassembly:"];
	if (instructions.length === 0) {
		lines.push("(empty)");
		return lines.join("\n");
	}
	let addressWidth = 0;
	let bytesWidth = 2;
	for (let ii = 0; ii < instructions.length; ii++) {
		const instruction = instructions[ii]!;
		if (instruction.address.length > addressWidth) addressWidth = instruction.address.length;
		const instructionBytesLen = instruction.instructionBytes?.length ?? 0;
		if (instructionBytesLen > bytesWidth) bytesWidth = instructionBytesLen;
	}
	for (let ii = 0; ii < instructions.length; ii++) {
		const instruction = instructions[ii]!;
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
		let lineStr = "";
		for (let pi = 0; pi < parts.length; pi++) {
			const part = parts[pi]!;
			if (part.length > 0) {
				if (lineStr.length > 0) lineStr += "  ";
				lineStr += part;
			}
		}
		lines.push(lineStr.trimEnd());
	}
	return lines.join("\n");
}

export function formatMemoryRead(address: string, data: string | undefined, unreadableBytes?: number): string {
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

export function formatTable(headers: string[], rows: string[][]): string {
	const widths: number[] = new Array(headers.length);
	for (let ci = 0; ci < headers.length; ci++) {
		let w = headers[ci]!.length;
		for (let ri = 0; ri < rows.length; ri++) {
			const cellLen = (rows[ri]![ci] ?? "").length;
			if (cellLen > w) w = cellLen;
		}
		widths[ci] = w;
	}
	const formatRow = (row: readonly string[]): string => {
		let result = "";
		for (let ci = 0; ci < row.length; ci++) {
			if (ci > 0) result += "  ";
			result += (row[ci] ?? "").padEnd(widths[ci]);
		}
		return result;
	};
	const separatorRow: string[] = new Array(headers.length);
	for (let ci = 0; ci < headers.length; ci++) separatorRow[ci] = "-".repeat(widths[ci]!);
	const allRows: string[] = new Array(2 + rows.length);
	allRows[0] = formatRow(headers);
	allRows[1] = formatRow(separatorRow);
	for (let ri = 0; ri < rows.length; ri++) allRows[ri + 2] = formatRow(rows[ri]!);
	return allRows.join("\n");
}

export function formatModules(modules: DapModule[]): string {
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

export function formatLoadedSources(sources: DapSource[]): string {
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

export function formatInstructionBreakpoints(breakpoints: DapInstructionBreakpointRecord[]): string {
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

export function formatDataBreakpointInfo(info: DapDataBreakpointInfoResponse): string {
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

export function formatDataBreakpoints(breakpoints: DapDataBreakpointRecord[]): string {
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

export function formatCustomResponse(command: string, body: unknown): string {
	let serialized = "";
	try {
		serialized = JSON.stringify(body, null, 2) ?? "null";
	} catch {
		serialized = Bun.inspect(body);
	}
	return `${command} response:\n${serialized}`;
}

export function formatSessions(sessions: DapSessionSummary[]): string {
	const parts: string[] = new Array(sessions.length);
	for (let si = 0; si < sessions.length; si++) {
		const session = sessions[si]!;
		const location = formatLocation(session);
		const lines = [
			`${session.id}: ${session.status}`,
			`  adapter=${session.adapter}`,
			`  cwd=${session.cwd}`,
			...(session.program ? [`  program=${session.program}`] : []),
			...(location ? [`  location=${location}`] : []),
			...(session.stopReason ? [`  reason=${session.stopReason}`] : []),
		];
		parts[si] = lines.join("\n");
	}
	return parts.join("\n\n");
}

export function formatEvaluation(evaluation: DapEvaluateResponse): string {
	const lines = [`Result: ${evaluation.result}`];
	if (evaluation.type) lines.push(`Type: ${evaluation.type}`);
	if (evaluation.variablesReference > 0) {
		lines.push(`Variables ref: ${evaluation.variablesReference}`);
	}
	return lines.join("\n");
}

export function buildOutcomeText(outcome: DapContinueOutcome, timeoutSec: number, verb: string): string {
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

export function getConfiguredAdapters(cwd: string): string {
	const adapters = getAvailableAdapters(cwd).map(adapter => adapter.name);
	const names = adapters.length > 0 ? adapters.join(", ") : "none";
	return truncateToWidth(replaceTabs(names), TRUNCATE_LENGTHS.LONG);
}

export const ADAPTER_UNAVAILABLE_MESSAGES: Readonly<Record<string, string>> = {
	debugpy: "adapter 'debugpy' is not available: neither python3 nor python was found in PATH",
	dlv: "adapter 'dlv' is not available: install with 'go install github.com/go-delve/delve/cmd/dlv@latest'",
	rdbg: "adapter 'rdbg' is not available: install with 'gem install debug'",
};

export const ADAPTER_CANONICAL_COMMANDS: Readonly<Record<string, string>> = {
	debugpy: "python3",
	dlv: "dlv",
	rdbg: "rdbg",
};

export function formatAdapterUnavailable(adapterName: string, command: string, cwd: string): string {
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

export async function classifyLaunchProgram(program: string): Promise<LaunchProgramKind> {
	try {
		return (await fs.stat(program)).isDirectory() ? "directory" : "file";
	} catch (error) {
		if (isEnoent(error)) return "missing";
		throw error;
	}
}

export function validateLaunchProgram(
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

export interface DebugRenderArgs extends Partial<DebugParams> {}

export function getActiveSessionSnapshot(): DapSessionSummary {
	const snapshot = dapSessionManager.getActiveSession();
	if (!snapshot) {
		throw new ToolError("No active debug session. Launch or attach first.");
	}
	return snapshot;
}

export function requireCapability(capability: keyof DapCapabilities, description: string): DapSessionSummary {
	const snapshot = getActiveSessionSnapshot();
	if (dapSessionManager.getCapabilities()?.[capability] !== true) {
		throw new ToolError(`Current adapter does not support ${description}`);
	}
	return snapshot;
}

export function resolveDisassemblyReference(memoryReference: string | undefined): string {
	if (memoryReference) {
		return memoryReference;
	}
	const snapshot = getActiveSessionSnapshot();
	if (snapshot.instructionPointerReference) {
		return snapshot.instructionPointerReference;
	}
	throw new ToolError(
		"disassemble requires memory_reference unless the current stop location has an instruction pointer reference",
	);
}

export function summarizeDebugCall(args: DebugRenderArgs): string {
	const action = args.action ? args.action.replaceAll("_", " ") : "request";
	if (args.program) {
		return `${action} ${truncateToWidth(shortenPath(args.program), TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.file && args.line !== undefined) {
		return `${action} ${truncateToWidth(`${shortenPath(args.file)}:${args.line}`, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.function) {
		return `${action} ${truncateToWidth(args.function, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.expression) {
		return `${action} ${truncateToWidth(args.expression, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.command) {
		return `${action} ${truncateToWidth(args.command, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.memory_reference) {
		return `${action} ${truncateToWidth(args.memory_reference, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.instruction_reference) {
		return `${action} ${truncateToWidth(args.instruction_reference, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.data_id) {
		return `${action} ${truncateToWidth(args.data_id, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.name) {
		return `${action} ${truncateToWidth(args.name, TRUNCATE_LENGTHS.TITLE)}`;
	}
	return action;
}

export const debugToolRenderer = {
	animatedPartialResult: true,
	renderCall(args: DebugRenderArgs, _options: RenderResultOptions, theme: Theme): Component {
		const text = renderStatusLine({ icon: "pending", title: "Debug", description: summarizeDebugCall(args) }, theme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: DebugToolDetails; isError?: boolean },
		options: RenderResultOptions,
		theme: Theme,
		args?: DebugRenderArgs,
	): Component {
		const outputBlock = new CachedOutputBlock();
		return markFramedBlockComponent({
			render(width: number): readonly string[] {
				const action = (args?.action ?? result.details?.action ?? "debug").replaceAll("_", " ");
				const success = !options.isPartial && !result.isError;
				const statusIcon = success
					? theme.styledSymbol("tool.debug", "accent")
					: formatStatusIcon(options.isPartial ? "running" : "error", theme, options.spinnerFrame);
				const header = `${statusIcon} Debug ${action}`;
				const snapshotRaw = result.details?.snapshot ? formatSessionSnapshot(result.details.snapshot) : [];
				const summaryLines: string[] = new Array(snapshotRaw.length);
				for (let li = 0; li < snapshotRaw.length; li++) {
					summaryLines[li] = replaceTabs(snapshotRaw[li]!);
				}
				const text = result.content.find(block => block.type === "text")?.text ?? "No output";
				const rawLines = replaceTabs(text).split("\n");
				const previewLimit = options.expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES;
				const limit = Math.min(rawLines.length, previewLimit);
				const displayedLines: string[] = new Array(limit);
				for (let li = 0; li < limit; li++) {
					displayedLines[li] = truncateToWidth(rawLines[li]!, TRUNCATE_LENGTHS.LINE);
				}
				const remaining = rawLines.length - displayedLines.length;
				if (remaining > 0) {
					displayedLines.push(
						theme.fg(
							"muted",
							`… ${formatMoreLines(remaining)} ${formatExpandHint(theme, options.expanded, true)}`,
						),
					);
				}
				return outputBlock.render(
					{
						header,
						state: result.isError ? "error" : "success",
						sections: [
							...(summaryLines.length > 0
								? [{ label: theme.fg("toolTitle", "Session"), lines: summaryLines }]
								: []),
							{ label: theme.fg("toolTitle", "Output"), lines: displayedLines },
						],
						width,
						applyBg: false,
					},
					theme,
				);
			},
			invalidate() {
				outputBlock.invalidate();
			},
		});
	},
	mergeCallAndResult: true,
	inline: true,
};
