// veyyon-side glue for the argot codec (the `argot` package, the single source;
// there is no in-tree copy). Argot is a per-project shorthand: the model writes
// cheap handles, the harness expands them to full text before anything outside
// the model's history sees them. This is the SAME wire-codec shape as the secret
// obfuscator's deobfuscate direction, so expansion runs at the same two seams and
// reuses the same content/JSON walkers (secrets/obfuscator) - one walk, one place.

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

/**
 * Adapt veyyon's positional settings into argot's gate options via {@link makeGate}.
 * When disabled, returns argot's shared inert gate.
 */
export function buildArgotGate(enabled: boolean, models: readonly string[], disableAboveTokens: number): ArgotGate {
	return makeGate(enabled, { models, disableAboveTokens });
}

/** Expand handles in a tool call's arguments before the tool runs. Identity until a dict loads. */
export function expandToolArguments(argot: ArgotSession, args: Record<string, unknown>): Record<string, unknown> {
	if (!argot.loaded) return args;
	return mapJsonStrings(args as JsonWithOptionalFields, s => argot.expand(s)) as Record<string, unknown>;
}

/**
 * Expand handles in a subagent's returned text using the child's codec at the return boundary.
 * The child expands its own result because the parent may bind the same handle names differently.
 * An `off` child has no codec, making expansion an identity operation.
 */
export function expandSubagentReturn(codec: ArgotSession | undefined, text: string): string {
	if (!text || codec === undefined || !codec.loaded) return text;
	return codec.expand(text);
}

/**
 * Build a stream decoder for a subagent's live token preview, buffering potential
 * split handles so raw handles are never rendered. Returns undefined when disabled.
 */
export function createSubagentStreamDecoder(codec: ArgotSession | undefined): StreamDecoder | undefined {
	if (codec === undefined || !codec.loaded) return undefined;
	return codec.streamDecoder();
}

/**
 * Decodes live streaming deltas and accumulated content for the main agent's output,
 * buffering partial handles across deltas for text, thinking, and tool arguments.
 */
export class ArgotStreamDisplayDecoder {
	readonly #codec: ArgotSession | undefined;
	readonly #slots = new Map<number, { decoder: StreamDecoder; decoded: string }>();
	readonly #argJson = new Map<number, { decoder: StreamDecoder; raw: string; decoded: string }>();
	#jsonVocabularyCache: Vocabulary | undefined;

	constructor(codec: ArgotSession | undefined) {
		this.#codec = codec?.loaded ? codec : undefined;
	}

	/**
	 * Decode a snapshot that may still grow, holding back any trailing fragment
	 * that could still form a handle.
	 */
	#decodeSnapshot(text: string): string {
		if (this.#codec === undefined || text === "") return text;
		return this.#codec.streamDecoder().push(text);
	}

	/**
	 * Decode a growing prefix of tool-call argument JSON using pre-escaped expansions
	 * so the output remains valid JSON during streaming.
	 */
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

	/**
	 * Feed one streamed fragment of tool argument JSON and return the newly decoded increment.
	 */
	#pushArgJson(contentIndex: number, delta: string, rawInput: boolean): string {
		if (this.#codec === undefined || delta === "") return delta;
		const slot = this.#argJson.get(contentIndex) ?? this.#freshArgSlot(contentIndex, rawInput);
		const increment = slot.decoder.push(delta);
		slot.decoded += increment;
		slot.raw += delta;
		return increment;
	}

	/**
	 * Create a per-block decoder for streamed tool arguments, using raw vocabulary for
	 * custom-tool verbatim payloads and JSON-escaped vocabulary for standard JSON tools.
	 */
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

	/**
	 * Feed a text/thinking delta for a content block and return the newly display-safe
	 * decoded increment, buffering partial handle boundaries.
	 */
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

	/**
	 * Map a partial message's content to its decoded display form for text, thinking,
	 * and tool-call arguments.
	 */
	decodeContent(content: AssistantMessage["content"]): AssistantMessage["content"] {
		if (this.#codec === undefined) return content;
		let changed = false;
		const mapped = content.map((block, index) => {
			if (block.type === "toolCall") {
				const decoded = this.#decodeToolCall(block, index);
				if (decoded !== block) changed = true;
				return decoded;
			}
			// A slot exists only for a block this decoder was fed deltas for. Without
			// one — a provider that delivers a block whole, or a rebuild that starts
			// mid-message — the accumulated text is still the display copy, so it is
			// decoded as a snapshot rather than left raw.
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

	/**
	 * Decode an assistant stream event for display, decoding deltas, partial snapshots,
	 * and expanding finished blocks wholesale.
	 */
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
			// The delta is a fragment of argument JSON, so its decoded increment is
			// derived from the accumulated prefix on the partial rather than from the
			// fragment alone: a handle can straddle two fragments, and only the
			// accumulation knows where the previous one stopped.
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

		return Object.keys(patch).length === 0 ? event : { ...event, ...patch };
	}

	/**
	 * Return a display copy of a tool-call block with arguments and partial JSON decoded.
	 */
	#decodeToolCall<T extends AssistantMessage["content"][number]>(block: T, index: number): T {
		if (this.#codec === undefined) return block;
		const sigil = this.#codec.vocabulary().sigil;
		const args = (block as { arguments?: Record<string, unknown> }).arguments;
		const rawJson = getStreamingPartialJson(block as StreamingPartialJsonCarrier);
		const jsonCarriesHandle = rawJson?.includes(sigil);
		// Look for the sigil before doing any work, and look for it WITHOUT
		// serialising. This runs on every stream update of every tool call, so a
		// `write` streaming a large file would otherwise allocate a fresh copy of
		// the whole body per token. The scan walks the strings already in memory and
		// stops at the first sigil, so a call with no handle costs one pass and no
		// allocation.
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

/**
 * Whether a tool call's streamed payload is verbatim text (e.g. custom tools) rather than JSON.
 */
function isRawWireToolCall(block: unknown): boolean {
	return (block as { customWireName?: string } | undefined)?.customWireName !== undefined;
}

/**
 * Fast check for whether any string in `value` contains `sigil` without serializing.
 */
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

/**
 * Derive a decode vocabulary with expansions pre-escaped for insertion into JSON string bodies.
 */
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

/**
 * Display walks include thinking blocks so human viewers see expanded handles in reasoning.
 */
const DISPLAY_WALK = { includeThinking: true } as const;

/**
 * Expand handles across an entire persisted session context for display, export, or resume.
 */
export function expandSessionContext(argot: ArgotSession, context: SessionContext): SessionContext {
	if (!argot.loaded) return context;
	const messages = mapAgentMessageStrings(context.messages, s => argot.expand(s), DISPLAY_WALK);
	return messages === context.messages ? context : { ...context, messages };
}
