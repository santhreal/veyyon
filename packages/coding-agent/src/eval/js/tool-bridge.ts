import type { AgentTool, AgentToolResult } from "@veyyon/agent-core";
import { validateToolArguments } from "@veyyon/ai/utils/validation";
import { errorMessage, isRecord } from "@veyyon/utils";
import { INTENT_FIELD } from "@veyyon/wire";
import type { ToolSession } from "../../tools";
import { ToolError } from "../../tools/tool-errors";
import { EVAL_AGENT_BRIDGE_NAME } from "../agent-bridge-name";
import { EVAL_BUDGET_BRIDGE_NAME, type EvalBudgetResult, runEvalBudget } from "../budget-bridge";
import { EVAL_COMPLETION_BRIDGE_NAME, runEvalCompletion } from "../completion-bridge";
import { EVAL_CONCURRENCY_BRIDGE_NAME, type EvalConcurrencyResult, runEvalConcurrency } from "../concurrency-bridge";
import type { JsStatusEvent } from "./shared/types";

export type { JsStatusEvent } from "./shared/types";

interface ToolBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

type ToolValue =
	| string
	| EvalBudgetResult
	| EvalConcurrencyResult
	| {
			text: string;
			details?: unknown;
			images?: Array<{ mimeType: string; data: string }>;
			hasError?: boolean;
	  };
function toolResultHasError(result: AgentToolResult): boolean {
	if ((result as { isError?: unknown }).isError === true) {
		return true;
	}
	if (!(result.details && typeof result.details === "object")) {
		return false;
	}
	return (result.details as { isError?: unknown }).isError === true;
}

function getTool(session: ToolSession, name: string): AgentTool {
	const tool = session.getToolByName?.(name);
	if (!tool) {
		throw new ToolError(`Unknown tool from js runtime: ${name}`);
	}
	return tool;
}

function normalizeArgs(args: unknown): unknown {
	if (!isRecord(args)) {
		return args;
	}
	const record = { ...(args as Record<string, unknown>) };
	if (record[INTENT_FIELD] === undefined) {
		record[INTENT_FIELD] = "js prelude";
	}
	return record;
}

/**
 * Validate cell-authored tool arguments against the tool's own schema.
 *
 * WHY: every other caller of a registered tool passes through
 * `validateToolArguments`: the agent loop does it before `tool.execute`, so a
 * model that omits a required field gets a tool result naming the field. This
 * bridge called `execute` directly, so a cell was the one caller that could
 * hand a tool a shape its schema rejects. `tool.ask({ questions: [{ id,
 * options }] })` reached the ask dialog with no question text, and the render
 * pass threw an uncaught `TypeError` that killed the session and every
 * subagent under it. Cell code is model-authored text with the same failure
 * modes as a tool call, so it gets the same gate, and the same repairs, so a
 * numeric string for a number argument keeps working.
 *
 * The bridge is the single choke point for all four transports (the JS worker,
 * the kernel HTTP bridge that serves Python and Ruby, the browser tab worker
 * and cmux), so validating here covers every one of them.
 */
function validateEvalToolArguments(tool: AgentTool, name: string, toolCallId: string, args: unknown): unknown {
	if (!isRecord(args)) {
		if (tool.lenientArgValidation) return args;
		throw new ToolError(
			`Tool "${name}" expects an object of arguments, received ${args === null ? "null" : typeof args}.`,
		);
	}
	// The harness injects the intent field into the WIRE schema the model sees,
	// not into the tool's own parameters, so a tool that never declared `i` would
	// see it as an unrecognized key. Validate without it, then put it back: the
	// status events and renderers downstream read it off the executed args.
	const { [INTENT_FIELD]: intent, ...schemaArgs } = args;
	try {
		const validated = validateToolArguments(tool, {
			type: "toolCall",
			id: toolCallId,
			name,
			arguments: schemaArgs,
		});
		return intent === undefined ? validated : { ...validated, [INTENT_FIELD]: intent };
	} catch (error) {
		if (tool.lenientArgValidation) return args;
		throw new ToolError(errorMessage(error));
	}
}

function summarizeToolResult(
	name: string,
	args: unknown,
	result: AgentToolResult,
	text: string,
	hasError: boolean,
): JsStatusEvent {
	const record = (args && typeof args === "object" ? (args as Record<string, unknown>) : {}) as Record<
		string,
		unknown
	>;
	const details = (
		result.details && typeof result.details === "object" ? (result.details as Record<string, unknown>) : {}
	) as Record<string, unknown>;
	const withError = (event: JsStatusEvent): JsStatusEvent =>
		hasError ? { ...event, hasError: true, error: text.slice(0, 500) } : event;

	switch (name) {
		case "read":
			return withError({ op: "read", path: record.path, chars: text.length, preview: text.slice(0, 500) });
		case "write":
			return withError({
				op: "write",
				path: record.path,
				chars: typeof record.content === "string" ? record.content.length : 0,
			});
		case "grep":
			return withError({
				op: "grep",
				pattern: record.pattern,
				path: record.path,
				count: details.matchCount ?? undefined,
			});
		case "glob":
			return withError({
				op: "glob",
				pattern: record.pattern,
				count: details.fileCount ?? undefined,
				matches: Array.isArray(details.files) ? details.files.slice(0, 20) : undefined,
			});
		case "bash":
			return withError({
				op: "run",
				cmd: record.command,
				code: typeof details.exitCode === "number" ? details.exitCode : undefined,
				output: text.slice(0, 500),
			});
		default:
			return withError({ op: name, chars: text.length });
	}
}

export async function callSessionTool(name: string, args: unknown, options: ToolBridgeOptions): Promise<ToolValue> {
	if (name === EVAL_COMPLETION_BRIDGE_NAME) {
		return await runEvalCompletion(args, options);
	}
	if (name === EVAL_AGENT_BRIDGE_NAME) {
		// Loaded on demand. `agent-bridge` runs a real subagent and pulls the MCP manager, task
		// discovery and the prompt registry with it; an eval that never calls `agent()` should not
		// pay for any of that. This branch already awaited, so deferring costs nothing, and a
		// failure to load throws here exactly as a missing symbol would have.
		const { runEvalAgent } = await import("../agent-bridge");
		return await runEvalAgent(args, options);
	}
	if (name === EVAL_BUDGET_BRIDGE_NAME) {
		return await runEvalBudget(args, options);
	}
	if (name === EVAL_CONCURRENCY_BRIDGE_NAME) {
		return runEvalConcurrency(args, options);
	}
	const tool = getTool(options.session, name);
	const normalizedArgs = normalizeArgs(args);
	const toolCallId = `js-${name}-${crypto.randomUUID()}`;
	try {
		// The registered tool is approval-wrapped, and the wrapper reads the whole
		// policy off this context. Omitting it does not skip a prompt, it decides
		// there is nothing to prompt about: no settings, so no `tools.approval`
		// deny; no plan mode; no cwd or secret boundary; no standing session
		// denial. An eval snippet is model-authored text, which is exactly the
		// caller those controls exist for.
		const executionArgs = validateEvalToolArguments(tool, name, toolCallId, normalizedArgs);
		const result = await tool.execute(
			toolCallId,
			executionArgs,
			options.signal,
			undefined,
			options.session.getToolContext?.(),
		);
		const textBlocks = result.content.filter(
			(content): content is { type: "text"; text: string } =>
				content.type === "text" && typeof content.text === "string",
		);
		const imageBlocks = result.content.filter(
			(content): content is { type: "image"; mimeType: string; data: string } =>
				content.type === "image" && typeof content.mimeType === "string" && typeof content.data === "string",
		);
		const text = textBlocks.map(block => block.text).join("");
		const hasError = toolResultHasError(result);
		options.emitStatus?.(summarizeToolResult(name, executionArgs, result, text, hasError));
		if (result.details === undefined && imageBlocks.length === 0 && !hasError) {
			return text;
		}
		const value: Exclude<ToolValue, string> = {
			text,
			details: result.details,
		};
		if (imageBlocks.length > 0) {
			value.images = imageBlocks.map(block => ({
				mimeType: block.mimeType,
				data: block.data,
			}));
		}
		if (hasError) {
			value.hasError = true;
		}
		return value;
	} catch (error) {
		options.emitStatus?.({
			op: name,
			error: errorMessage(error),
		});
		throw error;
	}
}
