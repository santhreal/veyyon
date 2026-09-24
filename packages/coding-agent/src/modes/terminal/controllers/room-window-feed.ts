/**
 * What one conversation's window in the room shows, read from the live session.
 *
 * A window shows the exchange the conversation is on: the last prompt the
 * operator gave it and everything that followed, with each tool call folded to
 * one line and its state. The feed rebuilds that snapshot only when the session
 * reports something that changes it, so a stage drawing sixty frames a second
 * reads the same object between two events and its painter can cache on it.
 *
 * Every string leaves here display-safe: assistant content goes through the
 * session's own display transform (secrets deobfuscated, argot expanded), and
 * everything is stripped of control bytes and tabs before a window wraps it.
 */

import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { contentText } from "@veyyon/utils/content-text";
import { sanitizeText } from "@veyyon/utils/sanitize-text";
import { replaceTabs } from "@veyyon/utils/tab-width";
import { sanitizeSingleLine } from "@veyyon/utils/wrap";
import type { AgentSession } from "../../../session/agent-session";
import type { AgentSessionEvent } from "../../../session/agent-session-types";
import { toolCallPrimaryArg } from "../../../session/session-history-format";
import { shortenPath } from "../../../tools/core/shorten-path";
import type { RoomFeedBlock, RoomWindowSnapshot, RoomWindowState } from "../components/room/room-view-model";

/** A window shows at most this many blocks after its prompt; it draws the tail of them anyway. */
const MAX_FEED_BLOCKS = 48;

/** The session events that change what a window shows. */
const FEED_EVENTS: ReadonlySet<AgentSessionEvent["type"]> = new Set([
	"agent_start",
	"agent_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_end",
	"auto_compaction_start",
	"auto_compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"cwd_changed",
]);

function displayText(text: string): string {
	return replaceTabs(sanitizeText(text)).trim();
}

function firstLine(text: string): string {
	return sanitizeSingleLine(displayText(text).split("\n", 1)[0] ?? "");
}

/** An operator's prompt: a user message the harness did not inject. */
function isPrompt(message: AgentMessage): boolean {
	return message.role === "user" && message.synthetic !== true;
}

function promptText(message: AgentMessage): string {
	if (message.role !== "user") return "";
	return displayText(contentText(message.content, { image: "[image]" }));
}

/** What the feed saw of the turn in flight, from the session's display-form events. */
export interface RoomLiveTurn {
	/** When the running turn started, in ms since epoch. */
	readonly startedAt?: number;
	/**
	 * The assistant message being streamed, as the session's `message_update`
	 * events carry it: already expanded for display, with a handle split across
	 * two deltas held back until it is whole. The raw `state.streamMessage` is
	 * never read, because it carries the model's own handles.
	 */
	readonly stream?: AssistantMessage;
}

/**
 * Build one conversation's snapshot. Exported for the stage's tests, which
 * build sessions and read what their windows would show.
 */
export function buildRoomWindowSnapshot(session: AgentSession, live: RoomLiveTurn = {}): RoomWindowSnapshot {
	const messages = session.messages;
	let start = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isPrompt(messages[i]!)) {
			start = i;
			break;
		}
	}
	const stream = session.isStreaming ? live.stream : undefined;
	const exchange: AgentMessage[] = start >= 0 ? messages.slice(start) : [];
	if (stream && !exchange.some(message => message.role === "assistant" && message.timestamp === stream.timestamp)) {
		exchange.push(stream);
	}

	const results = new Map<string, boolean>();
	for (const message of exchange) {
		if (message.role === "toolResult") results.set(message.toolCallId, message.isError);
	}
	const labels = new Map<string, string>();
	for (const tool of session.agent.state.tools) labels.set(tool.name, tool.label);

	const streaming = session.isStreaming;
	const blocks: RoomFeedBlock[] = [];
	let lastAssistant: AgentMessage | undefined;
	for (const message of exchange) {
		if (message.role === "user") {
			const text = promptText(message);
			if (text && message.synthetic !== true) blocks.push({ kind: "prompt", text });
			continue;
		}
		if (message.role !== "assistant") continue;
		lastAssistant = message;
		const isLive = message === stream;
		// Stored messages keep secrets obfuscated and handles unexpanded; the live
		// one arrived in display form already.
		const content = isLive ? message.content : session.displayAssistantContent(message.content);
		for (let i = 0; i < content.length; i++) {
			const block = content[i]!;
			if (block.type === "text") {
				const text = displayText(block.text);
				if (text) blocks.push({ kind: "text", text });
			} else if (block.type === "thinking") {
				// Reasoning is shown only while it is the thing being written.
				if (isLive && i === content.length - 1) blocks.push({ kind: "thinking" });
			} else if (block.type === "toolCall") {
				const failed = results.get(block.id);
				blocks.push({
					kind: "tool",
					label: sanitizeSingleLine(displayText(labels.get(block.name) ?? block.name)),
					detail: sanitizeSingleLine(displayText(toolCallPrimaryArg(block.name, block.arguments))),
					state: failed === undefined ? (streaming ? "running" : "error") : failed ? "error" : "ok",
				});
			}
		}
		if (message.stopReason === "error" && message.errorMessage) {
			blocks.push({ kind: "note", text: firstLine(message.errorMessage), tone: "error" });
		}
	}
	const head = blocks[0]?.kind === "prompt" ? [blocks[0]] : [];
	const tail = blocks.slice(head.length).slice(-MAX_FEED_BLOCKS);

	let state: RoomWindowState;
	if (streaming) {
		const since = live.startedAt ?? messages[start]?.timestamp ?? Date.now();
		const last = stream ? stream.content[stream.content.length - 1] : undefined;
		const activity = session.isCompacting
			? "compacting"
			: last?.type === "thinking"
				? "thinking"
				: last?.type === "text"
					? "writing"
					: last?.type === "toolCall" || session.state.pendingToolCalls.size > 0
						? "tool"
						: tail.length === 0
							? "starting"
							: "tool";
		state = { kind: "working", since, activity };
	} else if (lastAssistant?.role === "assistant" && lastAssistant.stopReason === "error") {
		state = { kind: "failed", reason: firstLine(lastAssistant.errorMessage ?? "") };
	} else if (lastAssistant?.role === "assistant" && lastAssistant.stopReason === "aborted") {
		state = { kind: "stopped" };
	} else if (exchange.length > 0) {
		state = { kind: "done", at: exchange[exchange.length - 1]!.timestamp };
	} else {
		state = { kind: "new" };
	}

	const model = session.model;
	return {
		state,
		blocks: [...head, ...tail],
		title: session.sessionManager.getSessionName() || undefined,
		model: model ? model.name || model.id : undefined,
		cwd: shortenPath(session.sessionManager.getCwd()),
	};
}

/**
 * One conversation's feed: its snapshot, rebuilt after the session events that
 * change it, and a callback the room uses to repaint and recount.
 */
export class RoomWindowFeed {
	readonly session: AgentSession;
	#version = 0;
	#built = -1;
	#snapshot: RoomWindowSnapshot | undefined;
	#startedAt: number | undefined;
	#stream: AssistantMessage | undefined;
	readonly #unsubscribe: () => void;
	readonly #unsubscribeName: () => void;

	constructor(session: AgentSession, onChange: (event: AgentSessionEvent["type"] | "renamed") => void) {
		this.session = session;
		this.#unsubscribe = session.subscribe(event => {
			if (!FEED_EVENTS.has(event.type)) return;
			if (event.type === "agent_start") this.#startedAt = Date.now();
			if (
				(event.type === "message_start" || event.type === "message_update") &&
				event.message.role === "assistant"
			) {
				this.#stream = event.message;
			} else if (event.type === "message_end" || event.type === "agent_end") {
				this.#stream = undefined;
			}
			this.#version++;
			onChange(event.type);
		});
		this.#unsubscribeName = session.sessionManager.onSessionNameChanged(() => {
			this.#version++;
			onChange("renamed");
		});
	}

	snapshot(): RoomWindowSnapshot {
		if (this.#snapshot === undefined || this.#built !== this.#version) {
			this.#snapshot = buildRoomWindowSnapshot(this.session, { startedAt: this.#startedAt, stream: this.#stream });
			this.#built = this.#version;
		}
		return this.#snapshot;
	}

	dispose(): void {
		this.#unsubscribe();
		this.#unsubscribeName();
	}
}
