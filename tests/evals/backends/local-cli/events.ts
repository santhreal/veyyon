/**
 * What a print-mode run's JSON event lines report. Every assistant message is one request that
 * re-sent the whole conversation, so turns and tokens are summed over them.
 */

export interface EventUsage {
	/** Assistant messages. */
	turns: number;
	toolCalls: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** Spend the provider priced, or zero when it prices nothing. */
	costUsd: number;
}

interface AssistantEvent {
	type?: string;
	message?: {
		role?: string;
		content?: Array<{ type?: string; text?: string }>;
		usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
	};
}

function* assistantMessages(lines: string): Generator<NonNullable<AssistantEvent["message"]>> {
	for (const line of lines.split("\n")) {
		if (!line.startsWith("{")) continue;
		let event: AssistantEvent;
		try {
			event = JSON.parse(line);
		} catch {
			// A line the CLI printed that is not an event, such as a warning.
			continue;
		}
		if (event.type === "message_end" && event.message?.role === "assistant") yield event.message;
	}
}

export function readUsage(lines: string): EventUsage {
	const usage: EventUsage = {
		turns: 0,
		toolCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0,
	};
	for (const message of assistantMessages(lines)) {
		usage.turns++;
		usage.toolCalls += message.content?.filter(block => block.type === "toolCall").length ?? 0;
		usage.inputTokens += message.usage?.input ?? 0;
		usage.outputTokens += message.usage?.output ?? 0;
		usage.cacheReadTokens += message.usage?.cacheRead ?? 0;
		usage.cacheWriteTokens += message.usage?.cacheWrite ?? 0;
		usage.costUsd += message.usage?.cost?.total ?? 0;
	}
	return usage;
}

/** The text of the last assistant message that said anything: the run's answer. */
export function finalText(lines: string): string {
	let text = "";
	for (const message of assistantMessages(lines)) {
		const said = (message.content ?? [])
			.filter(block => block.type === "text")
			.map(block => block.text ?? "")
			.join("");
		if (said.trim()) text = said;
	}
	return text;
}
