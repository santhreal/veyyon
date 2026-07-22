// veyyon-side glue for the argot codec (the `argot` package, the single source;
// there is no in-tree copy). Argot is a per-project shorthand: the model writes
// cheap handles, the harness expands them to full text before anything outside
// the model's history sees them. This is the SAME wire-codec shape as the secret
// obfuscator's deobfuscate direction, so expansion runs at the same two seams and
// reuses the same content/JSON walkers (secrets/obfuscator) - one walk, one place.

import type { AssistantMessage } from "@veyyon/ai";
import { type ArgotGate, type ArgotSession, makeGate, type StreamDecoder } from "argot";
import {
	type JsonValue,
	mapAgentMessageStrings,
	mapAssistantContentStrings,
	mapJsonStrings,
} from "./secrets/obfuscator";
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
	return mapJsonStrings(args as JsonValue, s => argot.expand(s)) as Record<string, unknown>;
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
 * Inert (no codec, or none loaded) the helper is a no-op: `push` drops nothing
 * because it stores nothing, and `decodeContent` returns the input reference.
 * Tool-call argument blocks pass through untouched: args are expanded before
 * execution (seam 1) and the finished message at `message_end` (seam 2), so the
 * only raw view is the in-flight args preview, which self-corrects.
 */
export class ArgotStreamDisplayDecoder {
	readonly #codec: ArgotSession | undefined;
	readonly #slots = new Map<number, { decoder: StreamDecoder; decoded: string }>();

	constructor(codec: ArgotSession | undefined) {
		this.#codec = codec !== undefined && codec.loaded ? codec : undefined;
	}

	/** Feed one streamed text/thinking delta for a content block. No-op when inert. */
	push(contentIndex: number, delta: string): void {
		if (this.#codec === undefined || delta === "") return;
		let slot = this.#slots.get(contentIndex);
		if (slot === undefined) {
			slot = { decoder: this.#codec.streamDecoder(), decoded: "" };
			this.#slots.set(contentIndex, slot);
		}
		slot.decoded += slot.decoder.push(delta);
	}

	/**
	 * Map a partial message's content to its decoded-for-display form: text and
	 * thinking blocks replaced by their proven-safe decoded accumulation, every
	 * other block (and the input, when nothing was decoded) returned as-is.
	 */
	decodeContent(content: AssistantMessage["content"]): AssistantMessage["content"] {
		if (this.#slots.size === 0) return content;
		let changed = false;
		const mapped = content.map((block, index) => {
			const slot = this.#slots.get(index);
			if (slot === undefined) return block;
			if (block.type === "text" && block.text !== slot.decoded) {
				changed = true;
				return { ...block, text: slot.decoded };
			}
			if (block.type === "thinking" && block.thinking !== slot.decoded) {
				changed = true;
				return { ...block, thinking: slot.decoded };
			}
			return block;
		});
		return changed ? mapped : content;
	}

	/** Release every held fragment (end of message); the message_end seam expands wholesale, so callers discard the output. */
	flush(): void {
		for (const slot of this.#slots.values()) {
			slot.decoder.flush();
		}
		this.#slots.clear();
	}
}

/** Expand handles in assistant content before it is displayed. Identity until a dict loads. */
export function expandAssistantContent(
	argot: ArgotSession,
	content: AssistantMessage["content"],
): AssistantMessage["content"] {
	if (!argot.loaded) return content;
	return mapAssistantContentStrings(content, s => argot.expand(s));
}

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
	const messages = mapAgentMessageStrings(context.messages, s => argot.expand(s));
	return messages === context.messages ? context : { ...context, messages };
}
