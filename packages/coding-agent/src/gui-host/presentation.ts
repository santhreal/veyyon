import type { AgentTool } from "@veyyon/agent-core";
import { errorMessage } from "@veyyon/utils";
import type {
	FramedBlockView,
	NoticeView,
	StatusRowView,
	ToolView,
	ToolViewContext,
	ViewLine,
	ViewSection,
	ViewStatus,
} from "@veyyon/view";
import type { ToolPresentation, TranscriptEntry } from "./wire";

export type { ToolPresentation } from "./wire";

/**
 * Normalized tool result representation passed to ToolViewRenderer.
 */
export interface RenderableToolResult {
	content: unknown[];
	details?: unknown;
	isError?: boolean;
}

/**
 * Extract plain text summary from arguments.
 */
function formatArgsSummary(args: unknown): string | undefined {
	if (args === null || args === undefined) return undefined;
	if (typeof args === "string") {
		const trimmed = args.trim();
		if (!trimmed) return undefined;
		return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
	}
	if (typeof args === "object") {
		const record = args as Record<string, unknown>;
		if (typeof record.path === "string" && record.path) return record.path;
		if (typeof record.file_path === "string" && record.file_path) return record.file_path;
		if (typeof record.command === "string" && record.command) {
			const cmd = record.command.trim();
			return cmd.length > 80 ? `${cmd.slice(0, 77)}...` : cmd;
		}
		if (typeof record.query === "string" && record.query) return record.query;
		if (typeof record.url === "string" && record.url) return record.url;
		if (typeof record.input === "string" && record.input) {
			const inp = record.input.trim();
			return inp.length > 80 ? `${inp.slice(0, 77)}...` : inp;
		}
		if (typeof record.action === "string" && record.action) return record.action;
		if (typeof record.op === "string" && record.op) return record.op;

		const entries = Object.entries(record).filter(([k]) => !k.startsWith("__"));
		if (entries.length > 0) {
			const preview = entries
				.slice(0, 2)
				.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
				.join(", ");
			return preview.length > 80 ? `${preview.slice(0, 77)}...` : preview;
		}
	}
	return undefined;
}

/**
 * Format arguments into detail lines for expanded block view.
 */
function formatArgsDetailLines(args: unknown): ViewLine[] {
	if (args === null || args === undefined) {
		return [[{ text: "(no arguments)", tone: "dim" }]];
	}
	if (typeof args === "string") {
		return args.split("\n").map(line => [{ text: line, tone: "text" }]);
	}
	if (typeof args === "object") {
		const record = args as Record<string, unknown>;
		const entries = Object.entries(record).filter(([k]) => !k.startsWith("__"));
		if (entries.length === 0) {
			return [[{ text: "(empty arguments)", tone: "dim" }]];
		}
		return entries.map(([key, val]) => [
			{ text: `${key}: `, tone: "muted" },
			{ text: typeof val === "string" ? val : JSON.stringify(val), tone: "text" },
		]);
	}
	return [[{ text: String(args), tone: "text" }]];
}

/**
 * Extract plain text from result content array.
 */
function extractTextFromResult(content: unknown[]): string {
	if (!Array.isArray(content)) return "";
	const pieces: string[] = [];
	for (const block of content) {
		if (typeof block === "string") {
			pieces.push(block);
		} else if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
			pieces.push(String(block.text));
		}
	}
	return pieces.join("\n");
}

function formatTextSummary(text: string): string {
	const first = text.split("\n").find(l => l.trim().length > 0) ?? "";
	const trimmed = first.trim();
	return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}

function formatDetailsLines(details: unknown): ViewLine[] {
	if (details === null || details === undefined) return [];
	if (typeof details === "string") {
		return details.split("\n").map(line => [{ text: line, tone: "text" }]);
	}
	if (typeof details === "object") {
		const record = details as Record<string, unknown>;
		return Object.entries(record)
			.filter(([k]) => !k.startsWith("__"))
			.map(([k, v]) => [
				{ text: `${k}: `, tone: "muted" },
				{ text: typeof v === "string" ? v : JSON.stringify(v), tone: "text" },
			]);
	}
	return [[{ text: String(details), tone: "text" }]];
}

/**
 * Normalize any result shape into standard RenderableToolResult.
 */
export function normalizeResult(result: unknown): RenderableToolResult {
	if (result && typeof result === "object") {
		const res = result as Record<string, unknown>;
		let content: unknown[] = [];
		if (Array.isArray(res.content)) {
			content = res.content;
		} else if (typeof res.content === "string") {
			content = [{ type: "text", text: res.content }];
		} else if (typeof res.output === "string") {
			content = [{ type: "text", text: res.output }];
		} else if (res.content !== undefined && res.content !== null) {
			content = [{ type: "text", text: JSON.stringify(res.content) }];
		}

		return {
			content,
			details: res.details,
			isError: Boolean(res.isError ?? res.is_error),
		};
	}
	if (typeof result === "string") {
		return {
			content: [{ type: "text", text: result }],
			isError: false,
		};
	}
	return {
		content: [{ type: "text", text: JSON.stringify(result) ?? "" }],
		isError: false,
	};
}

/**
 * Generic semantic call view for tools without semantic hooks.
 */
export function formatGenericCallView(toolName: string, args: unknown, context: ToolViewContext): ToolView {
	const status: ViewStatus = context.partial ? "running" : context.hasResult ? "done" : "pending";
	const description = formatArgsSummary(args);

	const header: StatusRowView = {
		kind: "statusRow",
		status,
		title: toolName,
		...(description ? { description } : {}),
	};

	if (!context.expanded) {
		return header;
	}

	const lines = formatArgsDetailLines(args);
	const sections: ViewSection[] = [
		{
			label: "Arguments",
			lines,
		},
	];

	const view: FramedBlockView = {
		kind: "framedBlock",
		header,
		sections,
	};
	return view;
}

/**
 * Generic semantic result view for tools without semantic hooks.
 */
export function formatGenericResultView(
	toolName: string,
	result: unknown,
	context: ToolViewContext,
	_args?: unknown,
): ToolView {
	const normalized = normalizeResult(result);
	const isError = Boolean(normalized.isError);
	const status: ViewStatus = isError ? "error" : "success";
	const text = extractTextFromResult(normalized.content);
	const description = text ? formatTextSummary(text) : isError ? "failed" : "completed";

	const header: StatusRowView = {
		kind: "statusRow",
		status,
		title: toolName,
		...(description ? { description } : {}),
	};

	if (!context.expanded) {
		return header;
	}

	const sections: ViewSection[] = [];
	if (text) {
		const textLines: ViewLine[] = text.split("\n").map(line => [{ text: line, tone: isError ? "error" : "output" }]);
		sections.push({
			label: "Output",
			lines: textLines,
		});
	}

	if (normalized.details !== undefined) {
		const detailLines = formatDetailsLines(normalized.details);
		if (detailLines.length > 0) {
			sections.push({
				label: "Details",
				lines: detailLines,
				separator: true,
			});
		}
	}

	if (sections.length === 0) {
		sections.push({
			label: "Output",
			lines: [[{ text: "(empty result)", tone: "dim" }]],
		});
	}

	const view: FramedBlockView = {
		kind: "framedBlock",
		header,
		state: status,
		sections,
		// The body is output the tool produced, not a verdict it wrote, so a host
		// states the outcome on the frame instead of across the text.
		contents: "data",
	};
	return view;
}

/**
 * Visibly surfaces a renderer exception without throwing or suppressing output.
 */
export function createRendererExceptionView(toolName: string, phase: "call" | "result", error: unknown): NoticeView {
	const message = errorMessage(error);
	return {
		kind: "notice",
		state: "error",
		headline: [
			{
				text: `Renderer error in ${toolName} (${phase}): ${message}`,
				tone: "error",
			},
		],
	};
}

/**
 * Construct the canonical ToolPresentation for a tool call.
 */
export function buildToolCallPresentation(
	toolName: string,
	args: unknown,
	tool: AgentTool | undefined,
	context: ToolViewContext,
): ToolPresentation {
	const callRenderer = tool?.view?.renderCall;
	if (callRenderer) {
		try {
			const view = callRenderer(args, context);
			if (view && typeof view === "object" && "kind" in view) {
				return { expanded: context.expanded, view };
			}
		} catch (error) {
			return {
				expanded: context.expanded,
				view: createRendererExceptionView(toolName, "call", error),
			};
		}
	}
	return {
		expanded: context.expanded,
		view: formatGenericCallView(toolName, args, context),
	};
}

/**
 * Construct the canonical ToolPresentation for a tool result.
 */
export function buildToolResultPresentation(
	toolName: string,
	result: unknown,
	callArgs: unknown,
	tool: AgentTool | undefined,
	context: ToolViewContext,
): ToolPresentation {
	// The renderer is declared over the tool's own details type; the normalized
	// payload carries the same three members the terminal path hands it.
	const resultRenderer = tool?.view?.renderResult as
		| ((result: RenderableToolResult, context: ToolViewContext, args?: unknown) => ToolView)
		| undefined;
	const normalized = normalizeResult(result);
	if (resultRenderer) {
		try {
			const view = resultRenderer(normalized, context, callArgs);
			if (view && typeof view === "object" && "kind" in view) {
				return { expanded: context.expanded, view };
			}
		} catch (error) {
			return {
				expanded: context.expanded,
				view: createRendererExceptionView(toolName, "result", error),
			};
		}
	}
	return {
		expanded: context.expanded,
		view: formatGenericResultView(toolName, normalized, context, callArgs),
	};
}

export interface TrackedToolCall {
	toolCallId: string;
	toolName: string;
	args: unknown;
	hasResult: boolean;
	result?: unknown;
	isError?: boolean;
	callEntryId?: string;
	resultEntryId?: string;
	assistantEntry?: TranscriptEntry;
	resultEntry?: TranscriptEntry;
}

/**
 * Tracks tool disclosure and call/result indexing per active session.
 */
export class PresentationLedger {
	readonly #disclosure = new Map<string, boolean>();
	readonly #calls = new Map<string, TrackedToolCall>();

	getDisclosure(callId: string): boolean {
		return this.#disclosure.get(callId) ?? false;
	}

	setDisclosure(callId: string, expanded: boolean): void {
		this.#disclosure.set(callId, expanded);
	}

	hasCall(callId: string): boolean {
		return this.#calls.has(callId);
	}

	getCall(callId: string): TrackedToolCall | undefined {
		return this.#calls.get(callId);
	}

	hasResult(callId: string): boolean {
		return this.#calls.get(callId)?.hasResult ?? false;
	}

	recordCall(
		toolCallId: string,
		toolName: string,
		args: unknown,
		entryId?: string,
		assistantEntry?: TranscriptEntry,
	): TrackedToolCall {
		const existing = this.#calls.get(toolCallId);
		if (existing) {
			existing.toolName = toolName || existing.toolName;
			existing.args = args ?? existing.args;
			if (entryId) existing.callEntryId = entryId;
			if (assistantEntry) existing.assistantEntry = assistantEntry;
			return existing;
		}
		const tracked: TrackedToolCall = {
			toolCallId,
			toolName,
			args,
			hasResult: false,
			callEntryId: entryId,
			assistantEntry,
		};
		this.#calls.set(toolCallId, tracked);
		return tracked;
	}

	recordResult(
		toolCallId: string,
		result: unknown,
		isError?: boolean,
		entryId?: string,
		resultEntry?: TranscriptEntry,
	): TrackedToolCall {
		const existing = this.#calls.get(toolCallId);
		if (existing) {
			existing.hasResult = true;
			existing.result = result;
			existing.isError = isError ?? existing.isError;
			if (entryId) existing.resultEntryId = entryId;
			if (resultEntry) existing.resultEntry = resultEntry;
			return existing;
		}
		const tracked: TrackedToolCall = {
			toolCallId,
			toolName: "tool",
			args: undefined,
			hasResult: true,
			result,
			isError,
			resultEntryId: entryId,
			resultEntry,
		};
		this.#calls.set(toolCallId, tracked);
		return tracked;
	}

	/**
	 * Mark call hasResult=true and update preceding assistant entry presentation if present.
	 */
	markResultAvailable(
		toolCallId: string,
		toolResolver?: (name: string) => AgentTool | undefined,
	): TranscriptEntry | undefined {
		const tracked = this.#calls.get(toolCallId);
		if (!tracked) return undefined;
		tracked.hasResult = true;
		if (tracked.assistantEntry) {
			const updated = this.regenerateCallEntryPresentation(tracked.assistantEntry, toolResolver);
			if (updated) {
				tracked.assistantEntry = updated;
				return updated;
			}
		}
		return undefined;
	}

	/**
	 * Regenerate tool call presentations in an assistant entry.
	 */
	regenerateCallEntryPresentation(
		entry: TranscriptEntry,
		toolResolver?: (name: string) => AgentTool | undefined,
		options?: { partial?: boolean },
	): TranscriptEntry | undefined {
		let modified = false;
		const newContent = entry.content.map(block => {
			if ("ToolCall" in block) {
				const call = block.ToolCall;
				const expanded = this.getDisclosure(call.id);
				const hasResult = this.hasResult(call.id);
				const tool = toolResolver ? toolResolver(call.name) : undefined;
				const presentation = buildToolCallPresentation(call.name, call.arguments, tool, {
					expanded,
					...(options?.partial ? { partial: true } : {}),
					hasResult,
				});
				modified = true;
				return {
					ToolCall: {
						...call,
						presentation,
					},
				};
			}
			return block;
		});
		if (!modified) return undefined;
		return {
			...entry,
			content: newContent,
		};
	}

	/**
	 * Regenerate tool result presentation in a result entry.
	 */
	regenerateResultEntryPresentation(
		entry: TranscriptEntry,
		toolResolver?: (name: string) => AgentTool | undefined,
		options?: { partial?: boolean },
	): TranscriptEntry | undefined {
		let modified = false;
		const newContent = entry.content.map(block => {
			if ("ToolResult" in block) {
				const res = block.ToolResult;
				const tracked = this.getCall(res.tool);
				const toolName = tracked?.toolName ?? "tool";
				const callArgs = tracked?.args;
				const expanded = this.getDisclosure(res.tool);
				const tool = toolResolver ? toolResolver(toolName) : undefined;
				// A recorded wire block has no `details`; the live result does,
				// so a registered renderer is given the richer of the two.
				const presentation = buildToolResultPresentation(
					toolName,
					tracked?.hasResult ? tracked.result : res,
					callArgs,
					tool,
					{ expanded, ...(options?.partial ? { partial: true } : {}), hasResult: true },
				);
				modified = true;
				return {
					ToolResult: {
						...res,
						presentation,
					},
				};
			}
			return block;
		});
		if (!modified) return undefined;
		return {
			...entry,
			content: newContent,
		};
	}

	clear(): void {
		this.#disclosure.clear();
		this.#calls.clear();
	}
}
