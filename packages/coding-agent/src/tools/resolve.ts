import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	CustomMessage,
} from "@veyyon/agent-core";
import type { Component } from "@veyyon/tui";
import { Text } from "@veyyon/tui";
import { errorMessage, prompt, untilAborted } from "@veyyon/utils";
import { type } from "arktype";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { toolsPrompts } from "../prompts/tools/rows";
import { Ellipsis, padToWidth, renderStatusLine, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import { replaceTabs } from "./render-utils";
import { ToolError } from "./tool-errors";

const resolveSchema = type({
	action: "'apply' | 'discard'",
	reason: type("string").describe("reason for action"),
	"extra?": type("Record<string, unknown>").describe("free-form metadata"),
});

type ResolveParams = typeof resolveSchema.infer;

export interface ResolveToolDetails {
	action: "apply" | "discard";
	reason: string;
	extra?: Record<string, unknown>;
	sourceToolName?: string;
	label?: string;
	sourceResultDetails?: unknown;
}

let pendingPreviewSeq = 0;

export function queueResolveHandler(
	session: ToolSession,
	options: {
		label: string;
		sourceToolName: string;
		apply(reason: string, extra?: Record<string, unknown>): Promise<AgentToolResult<unknown>>;
		reject?(reason: string, extra?: Record<string, unknown>): Promise<AgentToolResult<unknown> | undefined>;
	},
): void {
	const queue = session.getToolChoiceQueue?.();
	if (!queue) return;

	const id = `pending-action:${options.sourceToolName}:${pendingPreviewSeq++}`;

	const onInvoked = async (input: unknown): Promise<AgentToolResult<unknown>> => {
		const result = await runResolveInvocation(input as ResolveParams, {
			sourceToolName: options.sourceToolName,
			label: options.label,
			apply: options.apply,
			reject: options.reject,
			onApplyError: () => {
				queue.registerPendingInvoker(id, options.sourceToolName, onInvoked);
			},
		});
		queue.removePendingInvoker(id);
		return result;
	};

	queue.registerPendingInvoker(id, options.sourceToolName, onInvoked);
}

export function buildResolveReminderMessage(sourceToolName: string): CustomMessage {
	return {
		role: "custom",
		customType: "resolve-reminder",
		content: [
			"<system-reminder>",
			"This is a preview. Call the `resolve` tool to apply or discard these changes.",
			"</system-reminder>",
		].join("\n"),
		display: false,
		details: { toolName: sourceToolName },
		attribution: "agent",
		timestamp: Date.now(),
	};
}

export async function runResolveInvocation(
	params: ResolveParams,
	options: {
		sourceToolName: string;
		label: string;
		apply(reason: string, extra?: Record<string, unknown>): Promise<AgentToolResult<unknown>>;
		reject?(reason: string, extra?: Record<string, unknown>): Promise<AgentToolResult<unknown> | undefined>;
		onApplyError?(error: unknown): void;
	},
): Promise<AgentToolResult<ResolveToolDetails>> {
	const baseDetails: ResolveToolDetails = {
		action: params.action,
		reason: params.reason,
		sourceToolName: options.sourceToolName,
		label: options.label,
		...(params.extra != null ? { extra: params.extra } : {}),
	};
	if (params.action === "apply") {
		let result: AgentToolResult<unknown>;
		try {
			result = await options.apply(params.reason, params.extra);
		} catch (error) {
			try {
				options.onApplyError?.(error);
			} catch {}
			if (error instanceof ToolError) throw error;
			const message = errorMessage(error);
			throw new ToolError(`Apply failed: ${message}`);
		}
		return {
			...result,
			details: {
				...baseDetails,
				...(result.details != null ? { sourceResultDetails: result.details } : {}),
			},
		};
	}
	if (params.action === "discard" && options.reject != null) {
		const result = await options.reject(params.reason, params.extra);
		if (result != null) {
			return {
				...result,
				details: {
					...baseDetails,
					...(result.details != null ? { sourceResultDetails: result.details } : {}),
				},
			};
		}
	}
	return {
		content: [{ type: "text" as const, text: `Discarded: ${options.label}. Reason: ${params.reason}` }],
		details: baseDetails,
	};
}

export class ResolveTool implements AgentTool<typeof resolveSchema, ResolveToolDetails> {
	readonly name = "resolve";
	readonly approval = "read" as const;
	readonly label = "Resolve";
	readonly hidden = true;
	readonly description: string;
	readonly parameters = resolveSchema;
	readonly strict = true;
	readonly intent = (args: Partial<ResolveParams>) => {
		if (args.action === "discard") {
			return args.reason ? `discarding: ${args.reason}` : "discarding changes";
		}
		return args.reason ? `accepting: ${args.reason}` : "accepting changes";
	};

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(toolsPrompts["tools/resolve"].text);
	}

	async execute(
		_toolCallId: string,
		params: ResolveParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ResolveToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ResolveToolDetails>> {
		return untilAborted(signal, async () => {
			const invoker =
				this.session.peekQueueInvoker?.() ??
				this.session.peekPendingInvoker?.() ??
				this.session.peekStandingResolveHandler?.();
			if (!invoker) {
				this.session.clearPendingInvokers?.();
				if (params.action === "discard") {
					return {
						content: [{ type: "text" as const, text: "Nothing to discard; no pending action remains." }],
						details: {
							action: "discard",
							reason: params.reason,
							...(params.extra != null ? { extra: params.extra } : {}),
						},
					};
				}
				throw new ToolError("No pending action to resolve. Nothing to apply or discard.");
			}
			const result = (await invoker(params)) as AgentToolResult<ResolveToolDetails>;
			return result;
		});
	}
}

export const resolveToolRenderer = {
	renderCall(args: ResolveParams, _options: RenderResultOptions, uiTheme: Theme): Component {
		const reasonTrimmed = args.reason?.trim();
		const reason = reasonTrimmed ? truncateToWidth(reasonTrimmed, 72, Ellipsis.Omit) : undefined;
		const text = renderStatusLine(
			{
				icon: "pending",
				title: "Resolve",
				description: args.action,
				badge: {
					label: args.action === "apply" ? "proposed -> resolved" : "proposed -> rejected",
					color: args.action === "apply" ? "success" : "warning",
				},
				meta: reason ? [uiTheme.fg("muted", reason)] : undefined,
			},
			uiTheme,
		);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: ResolveToolDetails; isError?: boolean },
		_options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		const details = result.details;
		const label = replaceTabs(details?.label ?? "pending action");
		const reason = replaceTabs(details?.reason?.trim() || "No reason provided");
		const action = details?.action ?? "apply";
		const isApply = action === "apply" && !result.isError;
		const isFailedApply = action === "apply" && result.isError;
		const bgColor = result.isError ? "error" : isApply ? "success" : "warning";
		const icon = uiTheme.symbol(isApply ? "tool.resolve" : "status.error");
		const verb = isApply ? "Accept" : isFailedApply ? "Failed" : "Discard";
		const separator = ": ";
		const separatorIndex = label.indexOf(separator);
		const sourceLabel = separatorIndex > 0 ? label.slice(0, separatorIndex).trim() : undefined;
		const summaryLabel = separatorIndex > 0 ? label.slice(separatorIndex + separator.length).trim() : label;
		const sourceBadge = sourceLabel
			? uiTheme.bold(`${uiTheme.format.bracketLeft}${sourceLabel}${uiTheme.format.bracketRight}`)
			: undefined;
		const headerLine = `${icon} ${uiTheme.bold(`${verb}:`)} ${summaryLabel}${sourceBadge ? ` ${sourceBadge}` : ""}`;
		const lines = ["", headerLine, "", uiTheme.italic(reason), ""];

		return {
			render(width: number): readonly string[] {
				const lineWidth = Math.max(3, width);
				const innerWidth = Math.max(1, lineWidth - 2);
				const result: string[] = new Array(lines.length);
				for (let li = 0; li < lines.length; li++) {
					const truncated = truncateToWidth(lines[li]!, innerWidth, Ellipsis.Omit);
					const framed = ` ${padToWidth(truncated, innerWidth)} `;
					const padded = padToWidth(framed, lineWidth);
					result[li] = uiTheme.inverse(uiTheme.fg(bgColor, padded));
				}
				return result;
			},
			invalidate() {},
		};
	},

	inline: true,
	mergeCallAndResult: true,
};
