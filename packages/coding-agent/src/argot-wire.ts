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
 * Adapt veyyon's three settings fields to an argot gate. The gate SHAPE and its
 * on/off + defaulting rules live in argot's {@link makeGate} (the one home for
 * that construction, so a future gate field is added once, in argot, not
 * re-derived here); this wrapper only reshapes the harness's positional settings
 * into argot's options object. When the feature is off the gate is argot's shared
 * inert gate. Decoding never consults the gate.
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
 * Expand handles in a subagent's returned text at the RETURN boundary — the last
 * seam a child emits across, and the one a broken harness silently skips.
 *
 * A subagent running `fresh`/`inherit` writes `§handle` tokens keyed to its OWN
 * codec. The raw assistant text the executor captures from the child's stream
 * events (accumulated output chunks, the final turn, cancelled-run salvage) is in
 * that handle form, and it becomes the parent's tool result and on-disk artifact.
 * The parent's codec may bind those same handle names to a DIFFERENT expansion, or
 * not know them at all, so a raw handle that crossed the wire would reach the
 * parent either undecodable (a bare `§x` in its history) or, worse, silently
 * decoded to the parent's divergent meaning. Expanding here with the CHILD's codec
 * is what upholds the boundary contract documented on {@link ArgotSession.fork}:
 * "the child expands its own result, which covers any handle it added by loading a
 * project the parent never had."
 *
 * An `off` child has no codec (`undefined`) and never wrote a handle, so this is
 * identity; `expand` on text carrying no sigil is also identity. Both make it safe
 * to route every captured chunk through here unconditionally.
 */
export function expandSubagentReturn(codec: ArgotSession | undefined, text: string): string {
	if (!text || codec === undefined || !codec.loaded) return text;
	return codec.expand(text);
}

/**
 * Build a stream decoder for a subagent's LIVE token preview — the streaming
 * display seam. This is the one display seam a plain {@link ArgotSession.expand}
 * cannot serve, because the child's text arrives token by token and a handle can
 * split across two deltas (`§db` then `conn`): expanding each delta alone would
 * either flash a raw `§db…` in the TUI or resolve the shorter `§db` before the
 * longer `§dbconn` name finished. The {@link StreamDecoder} buffers exactly the
 * fragment that could still be a handle and returns only text that is safe to
 * show, so the operator never sees a raw handle in the live preview — the same
 * contract every other seam upholds, held under streaming.
 *
 * Returns `undefined` for an `off` child (no codec) or an unarmed one, so the
 * caller streams deltas straight through with zero added latency. Build one per
 * child message and feed every delta to `decoder.push`, rendering only its
 * return; call `decoder.flush()` at message end and `decoder.reset()` on abort.
 */
export function createSubagentStreamDecoder(codec: ArgotSession | undefined): StreamDecoder | undefined {
	if (codec === undefined || !codec.loaded) return undefined;
	return codec.streamDecoder();
}

/**
 * Per-assistant-message decoder for the TOP-LEVEL live stream preview — seam 3
 * for the main agent's own output. The interactive renderer re-renders the
 * accumulated partial message on every `message_update`, so decoding cannot be
 * per-delta (a handle can split across deltas: `§db` then `conn`); instead one
 * {@link StreamDecoder} per content index accumulates decoded-safe text, and
 * the display copy of the partial message shows exactly what the decoder has
 * proved safe — a handle appears whole only once its name and boundary are in.
 *
 * `push` also RETURNS the decoded increment for its delta, so a caller can emit a
 * decoded delta stream (print `--mode json`) whose deltas never carry a raw
 * handle; {@link decodeContent} exposes the same decoded text as accumulated
 * content, and the two agree by construction.
 *
 * Tool-call blocks are decoded too, on both of the views a renderer can pick
 * from: the provider-parsed `arguments` object, and the raw streamed argument
 * JSON the live reveal prefers while the object is still incomplete. Decoding
 * only `arguments` would not be enough, because a renderer showing a growing
 * `write` body reads the raw JSON and would keep painting `§handle` until the
 * call finished. The operator has to see a tool's input in expanded form the
 * whole time it is being written, not once it is done.
 *
 * Inert (no codec, or none loaded) the helper is a no-op: `push` returns its
 * delta unchanged and holds nothing, and `decodeContent` returns the input
 * reference.
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
	 * Decode a whole snapshot that may still grow, holding back the trailing
	 * fragment that could still turn into a handle. Used for values that arrive as
	 * successive snapshots rather than deltas (a tool call's parsed arguments),
	 * where there is no increment to feed a long-lived decoder.
	 *
	 * The held-back tail is at most a sigil plus the longest handle name, so what
	 * this drops is a few characters at the very end of a value still being
	 * written, which the next snapshot restores. That is the same trade the delta
	 * path makes, and it is the right one: a briefly missing character tail is
	 * invisible, a briefly visible `§a1` is not.
	 */
	#decodeSnapshot(text: string): string {
		if (this.#codec === undefined || text === "") return text;
		return this.#codec.streamDecoder().push(text);
	}

	/**
	 * Decode a growing prefix of tool-call argument JSON, expanding handles into
	 * JSON-escaped text so the result stays parseable.
	 *
	 * A handle inside argument JSON sits inside a string literal, so its expansion
	 * has to be escaped the way that literal's other characters are. Expanding it
	 * verbatim would splice a raw quote, backslash or newline into the JSON and
	 * break the very parse the live reveal runs on it, replacing a cosmetic
	 * problem with a broken preview. So the decode runs against a vocabulary whose
	 * expansions are pre-escaped: the same matching, a wire-safe replacement.
	 *
	 * The prefix is append-only in the normal case, so this feeds only the new
	 * suffix to a decoder that lives as long as the block, which keeps the work
	 * proportional to what arrived rather than to the whole payload. A provider
	 * that re-sends a snapshot which is not an extension of the last one (a
	 * rewritten preview) falls back to decoding it from scratch.
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
	 * Feed one streamed fragment of tool-call argument JSON and return the newly
	 * decodable part of it.
	 *
	 * The snapshot form above is the one a renderer reads, but the fragment is what
	 * a provider actually sends, and not every provider also publishes the
	 * accumulation. Both feed the same per-block decoder, so a stream that carries
	 * fragments and a stream that carries snapshots decode to the identical text
	 * and a stream carrying both never counts a byte twice.
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
	 * A per-block decoder for a tool call's streamed arguments, built once per
	 * message and matched to how that call's payload is encoded.
	 *
	 * A regular tool streams JSON, so its expansions are pre-escaped for a JSON
	 * string body. A tool invoked through OpenAI's custom-tool mechanism streams
	 * its payload VERBATIM (`apply_patch` sends a patch, not JSON), so escaping
	 * there would corrupt it: a newline in an expansion would land in the patch as
	 * the two characters backslash-n and the patch would no longer apply. The
	 * `customWireName` on the block is what distinguishes them.
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
	 * Feed one streamed text/thinking delta for a content block and return the
	 * newly display-safe decoded text for it (the increment). Inert (no codec, or
	 * none loaded) this is identity: the delta is returned unchanged. The returned
	 * increment never contains a raw handle — a handle split across deltas
	 * (`§db` then `conn`) is held until its boundary arrives — so the concatenation
	 * of increments equals the decoded accumulation {@link decodeContent} exposes,
	 * and a consumer that reconstructs text from deltas alone (e.g. `--mode json`)
	 * never sees a `§handle`.
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
	 * Map a partial message's content to its decoded-for-display form: text and
	 * thinking blocks replaced by their proven-safe decoded accumulation, tool-call
	 * blocks replaced by decoded arguments (both the parsed object and the streamed
	 * argument JSON a live reveal reads), every other block (and the input, when
	 * nothing was decoded) returned as-is.
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
	 * The display copy of one streamed assistant-message event.
	 *
	 * Every variant of the event carries a `partial` snapshot of the message so
	 * far, and several carry a payload of their own: the increment for a delta, the
	 * finished text for a block end, the assembled call for a tool-call end, the
	 * whole message for a terminal event. A renderer is free to read any of them,
	 * so all of them are decoded here rather than at each call site. Decoding only
	 * the fields the current TUI happens to read is how the raw form kept
	 * resurfacing: `--print`, ACP and the collab client each read a different one.
	 *
	 * Deltas and the in-flight snapshot go through the stream decoder, which
	 * withholds a fragment that could still become a handle. Anything final —
	 * `text_end`, `toolcall_end`, `done`, `error` — is expanded wholesale, because
	 * at that point there is nothing more to arrive and nothing left to withhold.
	 *
	 * This FEEDS the decoder with the event's delta, so it is the alternative to
	 * calling {@link push} directly, not a complement to it. Do both for the same
	 * delta and the text is counted twice.
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
	 * Decoded display copy of one tool-call block, or the block itself when it
	 * carries no handle.
	 *
	 * Both argument views are decoded because a renderer chooses between them: the
	 * streamed JSON while the object is still incomplete, the parsed object once it
	 * closes. Leaving either raw would show the operator a handle for as long as
	 * that view is the one on screen.
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
 * Whether this call's streamed payload is the tool's own verbatim syntax rather
 * than JSON.
 *
 * OpenAI's custom-tool mechanism sends the payload as written (`apply_patch`
 * streams a patch body), and the block records the wire-level name it came in
 * under. Everything else streams a JSON object. The two need different escaping
 * of an expansion, so the distinction has to be read off the block rather than
 * assumed.
 */
function isRawWireToolCall(block: unknown): boolean {
	return (block as { customWireName?: string } | undefined)?.customWireName !== undefined;
}

/**
 * Whether any string anywhere in `value` contains `sigil`, stopping at the first
 * one found.
 *
 * A cheap gate in front of the expander, and cheap is the requirement rather than
 * a nicety: it runs on every streamed update of every tool call, so it walks the
 * strings that are already in memory instead of serialising them into a new one.
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
 * The same decode vocabulary with every expansion pre-escaped for a JSON string
 * body, so decoding a handle that sits inside argument JSON yields text the JSON
 * parser still accepts.
 *
 * Escaping the replacement rather than the finished string is what keeps this
 * correct: escaping afterwards would also escape the JSON's own quotes and
 * backslashes, and escaping nothing would let an expansion containing a quote or
 * a newline terminate the string literal early.
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
 * Argot display walks include thinking; the secret codec's do not.
 *
 * The distinction is about where the walked copy can end up. A deobfuscated
 * transcript is fed back to the provider on resume, so it must leave thinking
 * byte-identical or the signature bound to it stops matching. An argot expansion
 * is only ever rendered, and a person reading the model's reasoning has the same
 * claim on seeing `src/db.ts` as a person reading its prose: the live stream
 * already decodes thinking, so leaving the finished message raw would make the
 * text flip back to a handle the moment the model stopped writing.
 */
const DISPLAY_WALK = { includeThinking: true } as const;

/**
 * Expand handles across a whole persisted transcript for display/export/resume.
 * The persisted session keeps cheap handles (replay stays cheap — the token
 * win), so any human-facing rebuild of that history — the resumed TUI
 * transcript, a `/share` export — must expand them the same way the live
 * message seam does, or reloaded history would show raw handles. Composes on
 * top of secret deobfuscation, which runs first. Identity until a dict loads.
 */
export function expandSessionContext(argot: ArgotSession, context: SessionContext): SessionContext {
	if (!argot.loaded) return context;
	const messages = mapAgentMessageStrings(context.messages, s => argot.expand(s), DISPLAY_WALK);
	return messages === context.messages ? context : { ...context, messages };
}
