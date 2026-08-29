import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@veyyon/agent-core";
import type { ToolExample } from "@veyyon/ai";
import { prompt } from "@veyyon/utils";
import {
	type DapEvaluateArguments,
	dapSessionManager,
	getAdapterConfigs,
	resolveLaunchOverrides,
	selectAttachAdapter,
	selectLaunchAdapter,
} from "../dap";
import { toolsPrompts } from "../prompts/tools/rows";
import { scopedTimeoutSignal } from "../utils/fetch-timeout";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import type { DebugParams, DebugToolDetails } from "./debug-helpers";
import {
	buildOutcomeText,
	classifyLaunchProgram,
	DEBUG_READONLY_ACTIONS,
	debugSchema,
	formatAdapterUnavailable,
	formatBreakpoints,
	formatCustomResponse,
	formatDataBreakpointInfo,
	formatDataBreakpoints,
	formatDisassembly,
	formatEvaluation,
	formatFunctionBreakpoints,
	formatInstructionBreakpoints,
	formatLoadedSources,
	formatMemoryRead,
	formatModules,
	formatScopes,
	formatSessionSnapshot,
	formatSessions,
	formatStackFrames,
	formatThreads,
	formatVariables,
	getConfiguredAdapters,
	requireCapability,
	resolveDisassemblyReference,
	validateLaunchProgram,
} from "./debug-helpers";
import { resolveToCwd } from "./path-utils";
import { ToolError } from "./tool-errors";
import { prependResultNotice, toolResult } from "./tool-result";
import { clampTimeout, formatTimeoutClampNotice } from "./tool-timeouts";

export { DEBUG_READONLY_ACTIONS, debugToolRenderer } from "./debug-helpers";

export class DebugTool implements AgentTool<typeof debugSchema, DebugToolDetails> {
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
	readonly parameters = debugSchema;
	readonly strict = true;

	readonly examples: readonly ToolExample<typeof debugSchema.infer>[] = [
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

	static createIf(session: ToolSession): DebugTool | null {
		return session.settings.get("debug.enabled") ? new DebugTool(session) : null;
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
		const details: DebugToolDetails = { action: params.action, success: true };
		const result = toolResult(details);
		switch (params.action) {
			case "launch": {
				if (!params.program) {
					// `program` is the thing to RUN; `file` is only a breakpoint's source location. A caller that supplied `file` (thinking it names the target
					const hint = params.file
						? ` You passed file: ${JSON.stringify(params.file)}. "file" only sets a breakpoint's source; it does not launch anything. To debug that path, pass it as "program": {"action":"launch","program":${JSON.stringify(params.file)}}.`
						: ` "program" is the executable, script, or package to run under the debugger, e.g. {"action":"launch","program":"src/main.py"}. "file"/"cwd" alone do not launch anything.`;
					throw new ToolError(`launch requires "program" (the target to debug).${hint}`);
				}
				const commandCwd = params.cwd ? resolveToCwd(params.cwd, this.session.cwd) : this.session.cwd;
				const program = resolveToCwd(params.program, commandCwd);
				const programKind = await classifyLaunchProgram(program);
				const selection = selectLaunchAdapter(program, commandCwd, params.adapter, programKind);
				if (selection.kind === "unavailable") {
					throw new ToolError(formatAdapterUnavailable(selection.adapterName, selection.command, commandCwd));
				}
				if (selection.kind === "none") {
					throw new ToolError(
						`No debugger adapter available. Installed adapters: ${getConfiguredAdapters(commandCwd)}`,
					);
				}
				const { adapter } = selection;
				validateLaunchProgram(program, commandCwd, programKind, adapter);
				const extraLaunchArguments = resolveLaunchOverrides(adapter, program, programKind);
				const snapshot = await dapSessionManager.launch(
					{ adapter, program, args: params.args, cwd: commandCwd, extraLaunchArguments },
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = snapshot;
				details.adapter = adapter.name;
				return result.text(formatSessionSnapshot(snapshot).join("\n")).done();
			}
			case "attach": {
				if (params.pid === undefined && params.port === undefined) {
					throw new ToolError("attach requires pid or port");
				}
				const commandCwd = params.cwd ? resolveToCwd(params.cwd, this.session.cwd) : this.session.cwd;
				const adapter = selectAttachAdapter(commandCwd, params.adapter, params.port);
				if (!adapter) {
					if (params.adapter) {
						const command = getAdapterConfigs(commandCwd)[params.adapter]?.command ?? params.adapter;
						throw new ToolError(formatAdapterUnavailable(params.adapter, command, commandCwd));
					}
					throw new ToolError(
						`No debugger adapter available. Installed adapters: ${getConfiguredAdapters(commandCwd)}`,
					);
				}
				const snapshot = await dapSessionManager.attach(
					{ adapter, cwd: commandCwd, pid: params.pid, port: params.port, host: params.host },
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = snapshot;
				details.adapter = adapter.name;
				return result.text(formatSessionSnapshot(snapshot).join("\n")).done();
			}
			case "set_breakpoint": {
				if (params.function) {
					const response = await dapSessionManager.setFunctionBreakpoint(
						params.function,
						params.condition,
						combinedSignal,
						timeoutSec * 1000,
					);
					details.snapshot = response.snapshot;
					details.functionBreakpoints = response.breakpoints;
					return result.text(formatFunctionBreakpoints(response.breakpoints)).done();
				}
				if (!params.file || params.line === undefined) {
					throw new ToolError("set_breakpoint requires file+line or function");
				}
				const file = resolveToCwd(params.file, this.session.cwd);
				const response = await dapSessionManager.setBreakpoint(
					file,
					params.line,
					params.condition,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.breakpoints = response.breakpoints;
				return result.text(formatBreakpoints(response.sourcePath, response.breakpoints)).done();
			}
			case "remove_breakpoint": {
				if (params.function) {
					const response = await dapSessionManager.removeFunctionBreakpoint(
						params.function,
						combinedSignal,
						timeoutSec * 1000,
					);
					details.snapshot = response.snapshot;
					details.functionBreakpoints = response.breakpoints;
					return result.text(formatFunctionBreakpoints(response.breakpoints)).done();
				}
				if (!params.file || params.line === undefined) {
					throw new ToolError("remove_breakpoint requires file+line or function");
				}
				const file = resolveToCwd(params.file, this.session.cwd);
				const response = await dapSessionManager.removeBreakpoint(
					file,
					params.line,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.breakpoints = response.breakpoints;
				return result.text(formatBreakpoints(response.sourcePath, response.breakpoints)).done();
			}
			case "set_instruction_breakpoint": {
				requireCapability("supportsInstructionBreakpoints", "instruction breakpoints");
				if (!params.instruction_reference) {
					throw new ToolError("instruction_reference is required for set_instruction_breakpoint");
				}
				const response = await dapSessionManager.setInstructionBreakpoint(
					params.instruction_reference,
					params.offset,
					params.condition,
					params.hit_condition,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.instructionBreakpoints = response.breakpoints;
				return result.text(formatInstructionBreakpoints(response.breakpoints)).done();
			}
			case "remove_instruction_breakpoint": {
				requireCapability("supportsInstructionBreakpoints", "instruction breakpoints");
				if (!params.instruction_reference) {
					throw new ToolError("instruction_reference is required for remove_instruction_breakpoint");
				}
				const response = await dapSessionManager.removeInstructionBreakpoint(
					params.instruction_reference,
					params.offset,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.instructionBreakpoints = response.breakpoints;
				return result.text(formatInstructionBreakpoints(response.breakpoints)).done();
			}
			case "data_breakpoint_info": {
				requireCapability("supportsDataBreakpoints", "data breakpoints");
				if (!params.name) {
					throw new ToolError("name is required for data_breakpoint_info");
				}
				const response = await dapSessionManager.dataBreakpointInfo(
					params.name,
					params.variable_ref ?? params.scope_id,
					params.frame_id,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.dataBreakpointInfo = response.info;
				return result.text(formatDataBreakpointInfo(response.info)).done();
			}
			case "set_data_breakpoint": {
				requireCapability("supportsDataBreakpoints", "data breakpoints");
				if (!params.data_id) {
					throw new ToolError("data_id is required for set_data_breakpoint");
				}
				const response = await dapSessionManager.setDataBreakpoint(
					params.data_id,
					params.access_type,
					params.condition,
					params.hit_condition,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.dataBreakpoints = response.breakpoints;
				return result.text(formatDataBreakpoints(response.breakpoints)).done();
			}
			case "remove_data_breakpoint": {
				requireCapability("supportsDataBreakpoints", "data breakpoints");
				if (!params.data_id) {
					throw new ToolError("data_id is required for remove_data_breakpoint");
				}
				const response = await dapSessionManager.removeDataBreakpoint(
					params.data_id,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.dataBreakpoints = response.breakpoints;
				return result.text(formatDataBreakpoints(response.breakpoints)).done();
			}
			case "continue": {
				const outcome = await dapSessionManager.continue(combinedSignal, timeoutSec * 1000);
				details.snapshot = outcome.snapshot;
				details.state = outcome.state;
				details.timedOut = outcome.timedOut;
				return result.text(buildOutcomeText(outcome, timeoutSec, "Continue")).done();
			}
			case "step_over": {
				const outcome = await dapSessionManager.stepOver(combinedSignal, timeoutSec * 1000);
				details.snapshot = outcome.snapshot;
				details.state = outcome.state;
				details.timedOut = outcome.timedOut;
				return result.text(buildOutcomeText(outcome, timeoutSec, "Step over")).done();
			}
			case "step_in": {
				const outcome = await dapSessionManager.stepIn(combinedSignal, timeoutSec * 1000);
				details.snapshot = outcome.snapshot;
				details.state = outcome.state;
				details.timedOut = outcome.timedOut;
				return result.text(buildOutcomeText(outcome, timeoutSec, "Step in")).done();
			}
			case "step_out": {
				const outcome = await dapSessionManager.stepOut(combinedSignal, timeoutSec * 1000);
				details.snapshot = outcome.snapshot;
				details.state = outcome.state;
				details.timedOut = outcome.timedOut;
				return result.text(buildOutcomeText(outcome, timeoutSec, "Step out")).done();
			}
			case "pause": {
				const snapshot = await dapSessionManager.pause(combinedSignal, timeoutSec * 1000);
				details.snapshot = snapshot;
				return result.text(formatSessionSnapshot(snapshot).concat("Program paused.").join("\n")).done();
			}
			case "evaluate": {
				if (!params.expression) {
					throw new ToolError("expression is required for evaluate");
				}
				const evaluationContext = (params.context as DapEvaluateArguments["context"] | undefined) ?? "repl";
				const response = await dapSessionManager.evaluate(
					params.expression,
					evaluationContext,
					params.frame_id,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.evaluation = response.evaluation;
				return result.text(formatEvaluation(response.evaluation)).done();
			}
			case "stack_trace": {
				const response = await dapSessionManager.stackTrace(params.levels, combinedSignal, timeoutSec * 1000);
				details.snapshot = response.snapshot;
				details.stackFrames = response.stackFrames;
				return result.text(formatStackFrames(response.stackFrames)).done();
			}
			case "threads": {
				const response = await dapSessionManager.threads(combinedSignal, timeoutSec * 1000);
				details.snapshot = response.snapshot;
				details.threads = response.threads;
				return result.text(formatThreads(response.threads)).done();
			}
			case "scopes": {
				const response = await dapSessionManager.scopes(params.frame_id, combinedSignal, timeoutSec * 1000);
				details.snapshot = response.snapshot;
				details.scopes = response.scopes;
				return result.text(formatScopes(response.scopes)).done();
			}
			case "variables": {
				const variableReference = params.variable_ref ?? params.scope_id;
				if (variableReference === undefined) {
					throw new ToolError("variables requires variable_ref or scope_id");
				}
				const response = await dapSessionManager.variables(variableReference, combinedSignal, timeoutSec * 1000);
				details.snapshot = response.snapshot;
				details.variables = response.variables;
				return result.text(formatVariables(response.variables)).done();
			}
			case "disassemble": {
				requireCapability("supportsDisassembleRequest", "disassembly");
				if (params.instruction_count === undefined) {
					throw new ToolError("instruction_count is required for disassemble");
				}
				const response = await dapSessionManager.disassemble(
					resolveDisassemblyReference(params.memory_reference),
					params.instruction_count,
					params.offset,
					params.instruction_offset,
					params.resolve_symbols,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.disassembly = response.instructions;
				return result.text(formatDisassembly(response.instructions)).done();
			}
			case "read_memory": {
				requireCapability("supportsReadMemoryRequest", "memory reads");
				if (!params.memory_reference) {
					throw new ToolError("memory_reference is required for read_memory");
				}
				if (params.count === undefined) {
					throw new ToolError("count is required for read_memory");
				}
				const response = await dapSessionManager.readMemory(
					params.memory_reference,
					params.count,
					params.offset,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.memoryAddress = response.address;
				details.memoryData = response.data;
				details.unreadableBytes = response.unreadableBytes;
				return result.text(formatMemoryRead(response.address, response.data, response.unreadableBytes)).done();
			}
			case "write_memory": {
				requireCapability("supportsWriteMemoryRequest", "memory writes");
				if (!params.memory_reference) {
					throw new ToolError("memory_reference is required for write_memory");
				}
				if (!params.data) {
					throw new ToolError("data is required for write_memory");
				}
				const response = await dapSessionManager.writeMemory(
					params.memory_reference,
					params.data,
					params.offset,
					params.allow_partial,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.bytesWritten = response.bytesWritten;
				return result
					.text(
						[
							"Memory write completed.",
							...(response.bytesWritten !== undefined ? [`Bytes written: ${response.bytesWritten}`] : []),
							...(response.offset !== undefined ? [`Offset: ${response.offset}`] : []),
						].join("\n"),
					)
					.done();
			}
			case "modules": {
				requireCapability("supportsModulesRequest", "module introspection");
				const response = await dapSessionManager.modules(
					params.start_module,
					params.module_count,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.modules = response.modules;
				return result.text(formatModules(response.modules)).done();
			}
			case "loaded_sources": {
				requireCapability("supportsLoadedSourcesRequest", "loaded sources");
				const response = await dapSessionManager.loadedSources(combinedSignal, timeoutSec * 1000);
				details.snapshot = response.snapshot;
				details.sources = response.sources;
				return result.text(formatLoadedSources(response.sources)).done();
			}
			case "custom_request": {
				if (!params.command) {
					throw new ToolError("command is required for custom_request");
				}
				const response = await dapSessionManager.customRequest(
					params.command,
					params.arguments,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.customBody = response.body;
				return result.text(formatCustomResponse(params.command, response.body)).done();
			}
			case "output": {
				const response = dapSessionManager.getOutput();
				details.snapshot = response.snapshot;
				details.output = response.output;
				return result.text(response.output.length > 0 ? response.output : "(no output captured)").done();
			}
			case "terminate": {
				const snapshot = await dapSessionManager.terminate(combinedSignal, timeoutSec * 1000);
				if (!snapshot) {
					return result.text("No debug session to terminate.").done();
				}
				details.snapshot = snapshot;
				return result.text(formatSessionSnapshot(snapshot).concat("Debug session terminated.").join("\n")).done();
			}
			case "sessions": {
				const sessions = dapSessionManager.listSessions();
				details.sessions = sessions;
				return result.text(formatSessions(sessions)).done();
			}
			default:
				throw new ToolError(`Unsupported debug action: ${params.action}`);
		}
	}
}
