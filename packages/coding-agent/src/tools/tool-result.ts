import type { AgentToolResult } from "@veyyon/agent-core";
import type { ImageContent, TextContent } from "@veyyon/ai";
import type { OutputSummary, TruncationResult } from "../session/streaming-output";
import type { OutputMeta, TruncationOptions, TruncationSummaryOptions, TruncationTextOptions } from "./output-meta";
import { outputMeta } from "./output-meta";

type ToolContent = Array<TextContent | ImageContent>;

type DetailsWithMeta = { meta?: OutputMeta };

export class ToolResultBuilder<TDetails extends DetailsWithMeta> {
	#details: TDetails;
	#meta = outputMeta();
	#content: ToolContent = [];
	#isError = false;
	#useless = false;

	constructor(details?: TDetails) {
		this.#details = details ?? ({} as TDetails);
	}

	text(text: string): this {
		this.#content = [{ type: "text", text }];
		return this;
	}

	content(content: ToolContent): this {
		this.#content = content;
		return this;
	}

	truncation(result: TruncationResult, options: TruncationOptions): this {
		this.#meta.truncation(result, options);
		return this;
	}

	truncationFromSummary(summary: OutputSummary, options: TruncationSummaryOptions): this {
		this.#meta.truncationFromSummary(summary, options);
		return this;
	}

	truncationFromText(text: string, options: TruncationTextOptions): this {
		this.#meta.truncationFromText(text, options);
		return this;
	}

	limits(limits: { matchLimit?: number; resultLimit?: number; headLimit?: number; columnMax?: number }): this {
		this.#meta.limits(limits);
		return this;
	}

	sourceUrl(value: string): this {
		this.#meta.sourceUrl(value);
		return this;
	}

	sourcePath(value: string): this {
		this.#meta.sourcePath(value);
		return this;
	}

	sourceInternal(value: string): this {
		this.#meta.sourceInternal(value);
		return this;
	}

	diagnostics(summary: string, messages: string[]): this {
		this.#meta.diagnostics(summary, messages);
		return this;
	}

	/** Flag the result as a non-throwing failure (agent-loop surfaces it as a tool error). */
	error(value = true): this {
		this.#isError = value;
		return this;
	}

	/** Marks the result contextually useless — compaction may elide it once consumed. */
	useless(value = true): this {
		this.#useless = value;
		return this;
	}

	done(): AgentToolResult<TDetails> {
		const meta = this.#meta.get();
		if (meta) {
			this.#details.meta = meta;
		}
		const hasDetails = Object.entries(this.#details).some(([, value]) => value !== undefined);

		return {
			content: this.#content,
			details: hasDetails ? this.#details : undefined,
			...(this.#isError ? { isError: true } : {}),
			...(this.#useless && !this.#isError ? { useless: true } : {}),
		};
	}
}

export function toolResult<TDetails extends DetailsWithMeta>(details?: TDetails): ToolResultBuilder<TDetails> {
	return new ToolResultBuilder(details);
}

/**
 * Prepend a notice line to an already-built tool result so it reaches the agent.
 * Reuses the result's first text block when present, otherwise inserts a new
 * one, and leaves details/isError/useless untouched. Use this to surface a
 * cross-cutting notice (for example a clamped timeout) from a wrapper that sits
 * above many per-action result builders, so the message rides on every path.
 */
export function prependResultNotice<TDetails>(
	result: AgentToolResult<TDetails>,
	notice: string,
): AgentToolResult<TDetails> {
	const content = [...result.content];
	const firstText = content.findIndex(block => block.type === "text");
	if (firstText >= 0) {
		const block = content[firstText] as TextContent;
		content[firstText] = { ...block, text: `${notice}\n\n${block.text}` };
	} else {
		content.unshift({ type: "text", text: notice });
	}
	return { ...result, content };
}
