import type { AssistantMessage } from "@veyyon/ai";
import {
	getStreamingPartialJson,
	type StreamingPartialJsonCarrier,
	setStreamingPartialJson,
} from "@veyyon/ai/utils/block-symbols";
import type { ArgotSession } from "argot/session";
import { makeStreamDecoder, type StreamDecoder } from "argot/stream";
import type { Vocabulary } from "argot/types";
import { type JsonWithOptionalFields, mapJsonStrings } from "./json-transform";
import { mapAgentMessageStrings, mapAssistantContentStrings } from "./secrets/obfuscator";
import type { SessionContext } from "./session/session-context";
import type { SessionMessageEntry } from "./session/session-entries";

export {
	buildArgotGate,
	createSubagentStreamDecoder,
	expandSubagentReturn,
	expandToolArguments,
} from "./argot-wire-helpers";

export class ArgotStreamDisplayDecoder {
	readonly #codec: ArgotSession | undefined;
	readonly #slots = new Map<number, { decoder: StreamDecoder; decoded: string }>();
	readonly #argJson = new Map<number, { decoder: StreamDecoder; raw: string; decoded: string }>();
	#jsonVocabularyCache: Vocabulary | undefined;

	constructor(codec: ArgotSession | undefined) {
		this.#codec = codec?.loaded ? codec : undefined;
	}

	#decodeSnapshot(text: string): string {
		if (this.#codec === undefined || text === "") return text;
		return this.#codec.streamDecoder().push(text);
	}

	#decodeArgJson(contentIndex: number, json: string, rawInput: boolean): string {
		if (this.#codec === undefined || json === "") return json;
		let slot = this.#argJson.get(contentIndex);
		if (slot === undefined || !json.startsWith(slot.raw)) {
			slot = this.#freshArgSlot(contentIndex, rawInput);
		}
		if (json.length > slot.raw.length) {
			slot.decoded += slot.decoder.push(json.slice(slot.raw.length));
			slot.raw = json;
		}
		return slot.decoded;
	}

	#pushArgJson(contentIndex: number, delta: string, rawInput: boolean): string {
		if (this.#codec === undefined || delta === "") return delta;
		const slot = this.#argJson.get(contentIndex) ?? this.#freshArgSlot(contentIndex, rawInput);
		const increment = slot.decoder.push(delta);
		slot.decoded += increment;
		slot.raw += delta;
		return increment;
	}

	#freshArgSlot(contentIndex: number, rawInput: boolean): { decoder: StreamDecoder; raw: string; decoded: string } {
		const vocabulary = rawInput ? this.#codec!.vocabulary() : this.#jsonVocabulary();
		const slot = { decoder: makeStreamDecoder(vocabulary), raw: "", decoded: "" };
		this.#argJson.set(contentIndex, slot);
		return slot;
	}

	#jsonVocabulary(): Vocabulary {
		this.#jsonVocabularyCache ??= jsonEscapedVocabulary(this.#codec!.vocabulary());
		return this.#jsonVocabularyCache;
	}

	push(contentIndex: number, delta: string): string {
		if (this.#codec === undefined) return delta;
		if (delta === "") return "";
		let slot = this.#slots.get(contentIndex);
		if (slot === undefined) {
			slot = { decoder: this.#codec.streamDecoder(), decoded: "" };
			this.#slots.set(contentIndex, slot);
		}
		const increment = slot.decoder.push(delta);
		slot.decoded += increment;
		return increment;
	}

	decodeContent(content: AssistantMessage["content"]): AssistantMessage["content"] {
		if (this.#codec === undefined) return content;
		let changed = false;
		const mapped = content.map((block, index) => {
			if (block.type === "toolCall") {
				const decoded = this.#decodeToolCall(block, index);
				if (decoded !== block) changed = true;
				return decoded;
			}
			const slot = this.#slots.get(index);
			if (block.type === "text") {
				const text = slot === undefined ? this.#decodeSnapshot(block.text) : slot.decoded;
				if (text === block.text) return block;
				changed = true;
				return { ...block, text };
			}
			if (block.type === "thinking") {
				const thinking = slot === undefined ? this.#decodeSnapshot(block.thinking) : slot.decoded;
				if (thinking === block.thinking) return block;
				changed = true;
				return { ...block, thinking };
			}
			return block;
		});
		return changed ? mapped : content;
	}

	decodeStreamEvent<T extends { type: string }>(event: T): T {
		if (this.#codec === undefined) return event;
		const codec = this.#codec;
		const patch: Record<string, unknown> = {};
		const source = event as unknown as {
			type: string;
			contentIndex?: number;
			delta?: string;
			content?: string;
			partial?: AssistantMessage;
			toolCall?: AssistantMessage["content"][number];
			message?: AssistantMessage;
			error?: AssistantMessage;
		};

		if (source.type === "text_delta" || source.type === "thinking_delta") {
			const decoded = this.push(source.contentIndex ?? 0, source.delta ?? "");
			if (decoded !== source.delta) patch.delta = decoded;
		} else if (source.type === "toolcall_delta") {
			const index = source.contentIndex ?? 0;
			const block = source.partial?.content?.[index] as StreamingPartialJsonCarrier | undefined;
			const json = block === undefined ? undefined : getStreamingPartialJson(block);
			const rawInput = isRawWireToolCall(block);
			const decoded =
				json === undefined
					? this.#pushArgJson(index, source.delta ?? "", rawInput)
					: (() => {
							const before = this.#argJson.get(index)?.decoded.length ?? 0;
							return this.#decodeArgJson(index, json, rawInput).slice(before);
						})();
			if (decoded !== source.delta) patch.delta = decoded;
		} else if (source.type === "text_end" || source.type === "thinking_end") {
			const expanded = codec.expand(source.content ?? "");
			if (expanded !== source.content) patch.content = expanded;
		} else if (source.type === "toolcall_end" && source.toolCall !== undefined) {
			const [expanded] = expandAssistantContent(codec, [source.toolCall]);
			if (expanded !== source.toolCall) patch.toolCall = expanded;
		} else if (source.type === "done" && source.message !== undefined) {
			const content = expandAssistantContent(codec, source.message.content);
			if (content !== source.message.content) patch.message = { ...source.message, content };
		} else if (source.type === "error" && source.error !== undefined) {
			const content = expandAssistantContent(codec, source.error.content);
			if (content !== source.error.content) patch.error = { ...source.error, content };
		}

		if (source.partial !== undefined) {
			const content = this.decodeContent(source.partial.content);
			if (content !== source.partial.content) patch.partial = { ...source.partial, content };
		}

		for (const _ in patch) return { ...event, ...patch };
		return event;
	}

	#decodeToolCall<T extends AssistantMessage["content"][number]>(block: T, index: number): T {
		if (this.#codec === undefined) return block;
		const sigil = this.#codec.vocabulary().sigil;
		const args = (block as { arguments?: Record<string, unknown> }).arguments;
		const rawJson = getStreamingPartialJson(block as StreamingPartialJsonCarrier);
		const jsonCarriesHandle = rawJson?.includes(sigil);
		const decodedArgs =
			args !== undefined && containsSigil(args, sigil)
				? (mapJsonStrings(args as JsonWithOptionalFields, s => this.#decodeSnapshot(s)) as Record<string, unknown>)
				: args;
		if (decodedArgs === args && !jsonCarriesHandle) return block;
		const copy = { ...block } as T;
		if (decodedArgs !== args) {
			(copy as { arguments?: Record<string, unknown> }).arguments = decodedArgs;
		}
		if (jsonCarriesHandle && rawJson !== undefined) {
			setStreamingPartialJson(
				copy as StreamingPartialJsonCarrier,
				this.#decodeArgJson(index, rawJson, isRawWireToolCall(block)),
			);
		}
		return copy;
	}

	flush(): void {
		for (const slot of this.#slots.values()) {
			slot.decoder.flush();
		}
		this.#slots.clear();
		this.#argJson.clear();
	}
}

function isRawWireToolCall(block: unknown): boolean {
	return (block as { customWireName?: string } | undefined)?.customWireName !== undefined;
}

function containsSigil(value: unknown, sigil: string): boolean {
	if (typeof value === "string") return value.includes(sigil);
	if (Array.isArray(value)) {
		for (const item of value) if (containsSigil(item, sigil)) return true;
		return false;
	}
	if (typeof value === "object" && value !== null) {
		for (const item of Object.values(value)) if (containsSigil(item, sigil)) return true;
		return false;
	}
	return false;
}

function escapeJsonStringBody(text: string): string {
	const quoted = JSON.stringify(text);
	return quoted.slice(1, -1);
}

function jsonEscapedVocabulary(vocab: Vocabulary): Vocabulary {
	const handles = new Map<string, string>();
	for (const [name, expansion] of vocab.handles) {
		handles.set(name, escapeJsonStringBody(expansion));
	}
	return { ...vocab, handles };
}

export function expandAssistantContent(
	argot: ArgotSession,
	content: AssistantMessage["content"],
): AssistantMessage["content"] {
	if (!argot.loaded) return content;
	return mapAssistantContentStrings(content, s => argot.expand(s), DISPLAY_WALK);
}

const DISPLAY_WALK = { includeThinking: true } as const;

export function expandSessionContext(argot: ArgotSession, context: SessionContext): SessionContext {
	if (!argot.loaded) return context;
	const messages = mapAgentMessageStrings(context.messages, s => argot.expand(s), DISPLAY_WALK);
	return messages === context.messages ? context : { ...context, messages };
}

export function expandSessionMessageEntries(
	argot: ArgotSession,
	entries: SessionMessageEntry[],
): SessionMessageEntry[] {
	if (!argot.loaded) return entries;
	const source = entries.map(entry => entry.message);
	const expanded = mapAgentMessageStrings(source, s => argot.expand(s), DISPLAY_WALK);
	if (expanded === source) return entries;
	return entries.map((entry, index) =>
		expanded[index] === entry.message ? entry : { ...entry, message: expanded[index] },
	);
}
