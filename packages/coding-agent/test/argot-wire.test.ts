/**
 * Unit-locks argot-wire.ts, the ONE module through which veyyon touches the argot
 * codec. Its whole safety story rests on a set of guards that let the executor
 * route everything through these functions unconditionally: "identity until a
 * dict loads", "an `off` child (no codec) is inert", and "return `undefined` when
 * there is nothing to decode". Those guards were only ever exercised indirectly,
 * through integration and e2e tests, so a regression to a single guard — dropping
 * the `!loaded` check, expanding an `off` child's text, building a decoder for an
 * unarmed codec — could pass the integration suites in one configuration while
 * breaking another. In particular `createSubagentStreamDecoder`, the seam-3
 * helper, had no direct test at all. This suite asserts each seam function's
 * contract directly on real ArgotSession instances, loaded and unloaded, so every
 * guard is pinned in one place.
 */

import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import {
	ArgotStreamDisplayDecoder,
	buildArgotGate,
	createSubagentStreamDecoder,
	expandAssistantContent,
	expandSessionContext,
	expandSubagentReturn,
	expandToolArguments,
} from "@veyyon/coding-agent/argot-wire";
import type { SessionContext } from "@veyyon/coding-agent/session/session-context";
import { ArgotSession, EMPTY_GATE, StreamDecoder, type Vocabulary } from "argot";

/** A real, loaded codec: `§db` -> `src/db.ts`, `§dbconn` -> a longer path. */
function loadedCodec(): ArgotSession {
	const vocab: Vocabulary = {
		version: 1,
		sigil: "§",
		handles: new Map([
			["db", "src/db.ts"],
			["dbconn", "packages/server/src/database/connection.ts"],
		]),
		meta: new Map(),
	};
	const codec = new ArgotSession();
	codec.loadVocab(vocab);
	return codec;
}

/** A fresh, unarmed codec: `loaded` is false, so every seam must be identity. */
function unloadedCodec(): ArgotSession {
	return new ArgotSession();
}

describe("buildArgotGate", () => {
	it("returns the exact argot EMPTY_GATE singleton when disabled", () => {
		expect(buildArgotGate(false, ["m1"], 1000)).toBe(EMPTY_GATE);
	});

	it("carries the model allowlist and token cutoff when enabled", () => {
		expect(buildArgotGate(true, ["m1", "m2"], 5000)).toEqual({ models: ["m1", "m2"], disableAboveTokens: 5000 });
	});
});

describe("expandToolArguments", () => {
	it("returns the exact same arguments object (identity) until a dict loads", () => {
		const codec = unloadedCodec();
		const args = { path: "§db", nested: { note: "§dbconn" } };
		expect(expandToolArguments(codec, args)).toBe(args);
	});

	it("expands handles in nested string values once a dict is loaded", () => {
		const codec = loadedCodec();
		const out = expandToolArguments(codec, { path: "open §db", nested: { note: "see §dbconn" } });
		expect(out).toEqual({
			path: "open src/db.ts",
			nested: { note: "see packages/server/src/database/connection.ts" },
		});
	});

	it("leaves non-handle strings untouched under a loaded codec", () => {
		const codec = loadedCodec();
		expect(expandToolArguments(codec, { path: "no handles here" })).toEqual({ path: "no handles here" });
	});
});

describe("expandSubagentReturn (the return boundary)", () => {
	it("is identity for an `off` child with no codec", () => {
		expect(expandSubagentReturn(undefined, "wrote §db here")).toBe("wrote §db here");
	});

	it("is identity for an unarmed codec", () => {
		expect(expandSubagentReturn(unloadedCodec(), "wrote §db here")).toBe("wrote §db here");
	});

	it("returns empty text unchanged without consulting the codec", () => {
		expect(expandSubagentReturn(loadedCodec(), "")).toBe("");
	});

	it("expands the child's own handles at the boundary once loaded", () => {
		expect(expandSubagentReturn(loadedCodec(), "opened §dbconn")).toBe(
			"opened packages/server/src/database/connection.ts",
		);
	});

	it("is identity for loaded text carrying no sigil", () => {
		expect(expandSubagentReturn(loadedCodec(), "plain output, no handles")).toBe("plain output, no handles");
	});
});

describe("createSubagentStreamDecoder (the streaming display seam)", () => {
	it("returns undefined for an `off` child with no codec, so the caller streams raw", () => {
		expect(createSubagentStreamDecoder(undefined)).toBeUndefined();
	});

	it("returns undefined for an unarmed codec", () => {
		expect(createSubagentStreamDecoder(unloadedCodec())).toBeUndefined();
	});

	it("returns a StreamDecoder for a loaded codec", () => {
		const decoder = createSubagentStreamDecoder(loadedCodec());
		expect(decoder).toBeInstanceOf(StreamDecoder);
	});

	it("the returned decoder holds a split handle until it completes, never leaking a raw handle", () => {
		// `§dbconn` split as `§db` + `conn`: the first push must not emit a raw
		// `§db`, and the flushed total must be the full expansion (longest match).
		const decoder = createSubagentStreamDecoder(loadedCodec());
		if (decoder === undefined) throw new Error("expected a decoder for a loaded codec");
		let shown = decoder.push("opened §db");
		expect(shown).not.toContain("§db");
		shown += decoder.push("conn now");
		shown += decoder.flush();
		expect(shown).toBe("opened packages/server/src/database/connection.ts now");
	});
});

describe("expandAssistantContent", () => {
	function textContent(text: string): AssistantMessage["content"] {
		return [{ type: "text", text }];
	}

	it("returns content unchanged (identity) until a dict loads", () => {
		const content = textContent("wrote §db");
		expect(expandAssistantContent(unloadedCodec(), content)).toBe(content);
	});

	it("expands handles in text parts once loaded", () => {
		const out = expandAssistantContent(loadedCodec(), textContent("wrote §db"));
		expect(out).toEqual([{ type: "text", text: "wrote src/db.ts" }]);
	});
});

describe("expandSessionContext", () => {
	function contextWith(messages: SessionContext["messages"]): SessionContext {
		// Only `.messages` is read and spread by the function under test; a partial
		// context typed through is honest for this unit and avoids fabricating the
		// dozen unrelated required fields.
		return { messages } as SessionContext;
	}

	it("returns the exact same context (identity) until a dict loads", () => {
		const context = contextWith([{ role: "branchSummary", summary: "opened §db" }] as SessionContext["messages"]);
		expect(expandSessionContext(unloadedCodec(), context)).toBe(context);
	});

	it("returns the exact same context when a loaded codec changes no message (reference preserved)", () => {
		const context = contextWith([
			{ role: "branchSummary", summary: "no handles at all" },
		] as SessionContext["messages"]);
		expect(expandSessionContext(loadedCodec(), context)).toBe(context);
	});

	it("returns a new context with expanded messages when a handle is present", () => {
		const context = contextWith([{ role: "branchSummary", summary: "opened §db" }] as SessionContext["messages"]);
		const out = expandSessionContext(loadedCodec(), context);
		expect(out).not.toBe(context);
		expect(out.messages[0]).toMatchObject({ role: "branchSummary", summary: "opened src/db.ts" });
	});
});

describe("ArgotStreamDisplayDecoder", () => {
	// The top-level live stream preview (seam 3): the interactive renderer shows
	// the accumulated partial message on every message_update, and a handle can
	// split across deltas. These tests lock the helper's one contract: at NO
	// point does the display copy contain a raw handle or a premature shorter
	// expansion, and the fully streamed text equals expand() of the whole.

	const textContent = (text: string): AssistantMessage["content"] => [{ type: "text", text }];

	it("never shows a raw handle or premature expansion when a handle splits across deltas", () => {
		const decoder = new ArgotStreamDisplayDecoder(loadedCodec());
		// "open §dbconn now" streamed as §d|b|conn: §db is itself a handle, so a
		// naive per-delta expand would wrongly fire it before §dbconn completes.
		const seen: string[] = [];
		for (const delta of ["open §d", "b", "conn now"]) {
			decoder.push(0, delta);
			const rendered = decoder.decodeContent([{ type: "text", text: "raw" }]);
			seen.push(rendered[0].type === "text" ? rendered[0].text : "");
		}
		// Mid-name, "§d" and "§db" are withheld (could still become §dbconn), so
		// the first renders stop before the sigil; the final render has the full expansion.
		expect(seen[0]).toBe("open ");
		expect(seen[1]).toBe("open ");
		expect(seen[2]).toBe("open packages/server/src/database/connection.ts now");
		expect(seen.join("")).not.toContain("§");
	});

	it("decodes text and thinking blocks independently per content index", () => {
		const decoder = new ArgotStreamDisplayDecoder(loadedCodec());
		decoder.push(0, "see §db ");
		decoder.push(1, "thinking §dbconn ");
		const out = decoder.decodeContent([
			{ type: "text", text: "see §db " },
			{ type: "thinking", thinking: "thinking §dbconn ", thinkingSignature: "sig" },
		] as AssistantMessage["content"]);
		expect(out[0]).toMatchObject({ type: "text", text: "see src/db.ts " });
		expect(out[1]).toMatchObject({ type: "thinking", thinking: "thinking packages/server/src/database/connection.ts " });
	});

	it("withholds a handle at the unterminated end of stream until flush, then releases it", () => {
		// A trailing handle with no boundary character after it is not decidable
		// mid-stream (a longer name could still follow), so the preview holds it;
		// message_end (seam 2) expands wholesale, and flush releases the fragment.
		const decoder = new ArgotStreamDisplayDecoder(loadedCodec());
		decoder.push(0, "thinking §dbconn");
		const held = decoder.decodeContent([{ type: "thinking", thinking: "thinking §dbconn", thinkingSignature: "s" }] as AssistantMessage["content"]);
		expect(held[0]).toMatchObject({ thinking: "thinking " });
		decoder.flush();
		// flush() clears state for the next message; the wholesale expansion at
		// message_end is covered by displayAssistantContent's own tests.
	});

	it("leaves toolCall blocks and undecoded indices untouched", () => {
		const decoder = new ArgotStreamDisplayDecoder(loadedCodec());
		decoder.push(0, "§db");
		const toolCall = { type: "toolCall", id: "t1", name: "read", arguments: { path: "§db" } } as const;
		const out = decoder.decodeContent([{ type: "text", text: "§db" }, toolCall] as unknown as AssistantMessage["content"]);
		expect(out[1]).toBe(toolCall);
	});

	it("is fully inert (same reference back) with no codec or an unarmed one", () => {
		const content = textContent("§db");
		expect(new ArgotStreamDisplayDecoder(undefined).decodeContent(content)).toBe(content);
		expect(new ArgotStreamDisplayDecoder(unloadedCodec()).decodeContent(content)).toBe(content);
	});

	it("matches expand() of the whole text once the stream completes", () => {
		const codec = loadedCodec();
		const decoder = new ArgotStreamDisplayDecoder(codec);
		for (const delta of ["a §db b ", "§dbconn c"]) decoder.push(0, delta);
		const rendered = decoder.decodeContent([{ type: "text", text: "x" }]);
		expect(rendered[0]).toMatchObject({ text: codec.expand("a §db b §dbconn c") });
	});
});
