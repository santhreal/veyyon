// veyyon-side glue for the argot codec (the `argot` package, the single source; there is no in-tree copy). Argot is a per-project shorthand: the model writes

import type { AssistantMessage } from "@veyyon/ai";
import {
	getStreamingPartialJson,
	type StreamingPartialJsonCarrier,
	setStreamingPartialJson,
} from "@veyyon/ai/utils/block-symbols";
import {
	type ArgotGate,
	type ArgotSession,
	makeGate,
	makeStreamDecoder,
	type StreamDecoder,
	type Vocabulary,
} from "argot";
import { type JsonWithOptionalFields, mapJsonStrings } from "./json-transform";
import { mapAgentMessageStrings, mapAssistantContentStrings } from "./secrets/obfuscator";
import type { SessionContext } from "./session/session-context";
import type { SessionMessageEntry } from "./session/session-entries";

/** Adapt veyyon's three settings fields to an argot gate. The gate SHAPE and its on/off + defaulting rules live in argot's {@link makeGate} (the one home for */
export function buildArgotGate(enabled: boolean, models: readonly string[], disableAboveTokens: number): ArgotGate {
	return makeGate(enabled, { models, disableAboveTokens });
}

/** Expand handles in a tool call's arguments before the tool runs. Identity until a dict loads. */
export function expandToolArguments(argot: ArgotSession, args: Record<string, unknown>): Record<string, unknown> {
	if (!argot.loaded) return args;
	return mapJsonStrings(args as JsonWithOptionalFields, s => argot.expand(s)) as Record<string, unknown>;
}

/** Expand handles in a subagent's returned text at the RETURN boundary — the last seam a child emits across, and the one a broken harness silently skips. */
export function expandSubagentReturn(codec: ArgotSession | undefined, text: string): string {
	if (!text || codec === undefined || !codec.loaded) return text;
	return codec.expand(text);
}

/** Build a stream decoder for a subagent's LIVE token preview — the streaming display seam. This is the one display seam a plain {@link ArgotSession.expand} */
export function createSubagentStreamDecoder(codec: ArgotSession | undefined): StreamDecoder | undefined {
	if (codec === undefined || !codec.loaded) return undefined;
	return codec.streamDecoder();
}

/** Per-assistant-message decoder for the TOP-LEVEL live stream preview — seam 3 for the main agent's own output. The interactive renderer re-renders the */
export class ArgotStreamDisplayDecoder {
	readonly #codec: ArgotSession | undefined;
	readonly #slots = new Map<number, { decoder: StreamDecoder; decoded: string }>();
	readonly #argJson = new Map<number, { decoder: StreamDecoder; raw: string; decoded: string }>();
	#jsonVocabularyCache: Vocabulary | undefined;

	constructor(codec: ArgotSession | undefined) {
		this.#codec = codec?.loaded ? codec : undefined;
	}

	/** Decode a whole snapshot that may still grow, holding back the trailing fragment that could still turn into a handle. Used for values that arrive as */
	#decodeSnapshot(text: string): string {
		if (this.#codec === undefined || text === "") return text;
		return this.#codec.streamDecoder().push(text);
	}

	/** Decode a growing prefix of tool-call argument JSON, expanding handles into JSON-escaped text so the result stays parseable. */
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

	/** Feed one streamed fragment of tool-call argument JSON and return the newly decodable part of it. */
	#pushArgJson(contentIndex: number, delta: string, rawInput: boolean): string {
		if (this.#codec === undefined || delta === "") return delta;
		const slot = this.#argJson.get(contentIndex) ?? this.#freshArgSlot(contentIndex, rawInput);
		const increment = slot.decoder.push(delta);
		slot.decoded += increment;
		slot.raw += delta;
		return increment;
	}

	/** A per-block decoder for a tool call's streamed arguments, built once per message and matched to how that call's payload is encoded. */
	#freshArgSlot(contentIndex: number, rawInput: boolean): { decoder: StreamDecoder; raw: string; decoded: string } {
		const vocabulary = rawInput ? this.#codec!.vocabulary() : this.#jsonVocabulary();
		const slot = { decoder: makeStreamDecoder(vocabulary), raw: "", decoded: "" };
		this.#argJson.set(contentIndex, slot);
		return slot;
	}

	/** The JSON-escaped decode vocabulary, derived once and reused for every block. */
	#jsonVocabulary(): Vocabulary {
		this.#jsonVocabularyCache ??= jsonEscapedVocabulary(this.#codec!.vocabulary());
		return this.#jsonVocabularyCache;
	}

	/** Feed one streamed text/thinking delta for a content block and return the newly display-safe decoded text for it (the increment). Inert (no codec, or */
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

	/** Map a partial message's content to its decoded-for-display form: text and thinking blocks replaced by their proven-safe decoded accumulation, tool-call */
	decodeContent(content: AssistantMessage["content"]): AssistantMessage["content"] {
		if (this.#codec === undefined) return content;
		let changed = false;
		const mapped = content.map((block, index) => {
			if (block.type === "toolCall") {
				const decoded = this.#decodeToolCall(block, index);
				if (decoded !== block) changed = true;
				return decoded;
			}
			// A slot exists only for a block this decoder was fed deltas for. Without one — a provider that delivers a block whole, or a rebuild that starts
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

	/** The display copy of one streamed assistant-message event. Every variant of the event carries a `partial` snapshot of the message so */
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
			// The delta is a fragment of argument JSON, so its decoded increment is derived from the accumulated prefix on the partial rather than from the
			const index = source.contentIndex ?? 0;
			const block = source.partial?.content?.[index] as StreamingPartialJsonCarrier | undefined;
			const json = block === undefined ? undefined : getStreamingPartialJson(block);
			const rawInput = isRawWireToolCall(block);
			// Prefer the accumulation when the provider publishes one, since it is
			// authoritative about where the previous fragment stopped; fall back to
			// the fragment itself when it does not.
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

	/** Decoded display copy of one tool-call block, or the block itself when it carries no handle. */
	#decodeToolCall<T extends AssistantMessage["content"][number]>(block: T, index: number): T {
		if (this.#codec === undefined) return block;
		const sigil = this.#codec.vocabulary().sigil;
		const args = (block as { arguments?: Record<string, unknown> }).arguments;
		const rawJson = getStreamingPartialJson(block as StreamingPartialJsonCarrier);
		const jsonCarriesHandle = rawJson?.includes(sigil);
		// Look for the sigil before doing any work, and look for it WITHOUT serialising. This runs on every stream update of every tool call, so a
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

	/** Release every held fragment (end of message); the message_end seam expands wholesale, so callers discard the output. */
	flush(): void {
		for (const slot of this.#slots.values()) {
			slot.decoder.flush();
		}
		this.#slots.clear();
		this.#argJson.clear();
	}
}

/** Whether this call's streamed payload is the tool's own verbatim syntax rather than JSON. */
function isRawWireToolCall(block: unknown): boolean {
	return (block as { customWireName?: string } | undefined)?.customWireName !== undefined;
}

/** Whether any string anywhere in `value` contains `sigil`, stopping at the first one found. */
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

/** A JSON string body's escaping of `text`, without the surrounding quotes. */
function escapeJsonStringBody(text: string): string {
	const quoted = JSON.stringify(text);
	return quoted.slice(1, -1);
}

/** The same decode vocabulary with every expansion pre-escaped for a JSON string body, so decoding a handle that sits inside argument JSON yields text the JSON */
function jsonEscapedVocabulary(vocab: Vocabulary): Vocabulary {
	const handles = new Map<string, string>();
	for (const [name, expansion] of vocab.handles) {
		handles.set(name, escapeJsonStringBody(expansion));
	}
	return { ...vocab, handles };
}

/** Expand handles in assistant content before it is displayed. Identity until a dict loads. */
export function expandAssistantContent(
	argot: ArgotSession,
	content: AssistantMessage["content"],
): AssistantMessage["content"] {
	if (!argot.loaded) return content;
	return mapAssistantContentStrings(content, s => argot.expand(s), DISPLAY_WALK);
}

/** Argot display walks include thinking; the secret codec's do not. The distinction is about where the walked copy can end up. A deobfuscated */
const DISPLAY_WALK = { includeThinking: true } as const;

/** Expand handles across a whole persisted transcript for display/export/resume. The persisted session keeps cheap handles (replay stays cheap — the token */
export function expandSessionContext(argot: ArgotSession, context: SessionContext): SessionContext {
	if (!argot.loaded) return context;
	const messages = mapAgentMessageStrings(context.messages, s => argot.expand(s), DISPLAY_WALK);
	return messages === context.messages ? context : { ...context, messages };
}

/** Expand handles across persisted transcript entries read straight off disk. `expandSessionContext` covers a rebuild that goes through `SessionManager`. */
export function expandSessionMessageEntries(
	argot: ArgotSession,
	entries: SessionMessageEntry[],
): SessionMessageEntry[] {
	if (!argot.loaded) return entries;
	const source = entries.map(entry => entry.message);
	const expanded = mapAgentMessageStrings(source, s => argot.expand(s), DISPLAY_WALK);
	// `mapAgentMessageStrings` hands the input array back untouched when no
	// string moved, which is the common case once a transcript is fully read.
	if (expanded === source) return entries;
	return entries.map((entry, index) =>
		expanded[index] === entry.message ? entry : { ...entry, message: expanded[index] },
	);
}
