/**
 * The operator always sees a tool's INPUT expanded, at every moment of the call.
 *
 * WHY THIS SUITE EXISTS. Argot lets the model write `§db` where it means
 * `src/db.ts`, which is the whole token win, and every surface a person looks at
 * is supposed to show the expansion instead. Tool-call arguments were the one
 * surface where that was not true, and it was not true in three separate places
 * at once:
 *
 *   1. The live preview read the streamed argument JSON, which nothing decoded,
 *      so a `write` body was painted with raw `§handle` text for as long as it
 *      took the model to stream it.
 *   2. The parsed `arguments` object was not decoded either, so a provider that
 *      sends no streamed JSON showed handles the same way.
 *   3. `tool_execution_start`, which the renderer treats as authoritative and
 *      uses to overwrite whatever the preview had, carried the arguments from
 *      BEFORE the expansion transform. Even a correct preview was overwritten
 *      with the raw form, and that is the form that stayed on screen.
 *
 * The tests below pin each of those, plus the property that makes the fix safe
 * rather than merely nice: decoding the streamed JSON must not break the JSON.
 * An expansion containing a quote or a newline spliced in verbatim would
 * terminate the string literal early and take the whole preview down with it, so
 * the escaping is asserted by parsing the decoded result, not by eyeballing it.
 */

import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { getStreamingPartialJson, setStreamingPartialJson } from "@veyyon/ai/utils/block-symbols";
import { ArgotStreamDisplayDecoder } from "@veyyon/coding-agent/argot-wire";
import { ArgotSession, type Vocabulary } from "argot";

/**
 * A loaded codec whose handles cover the two cases that matter here: an ordinary
 * path, a nested-name pair where the shorter name prefixes the longer one, and
 * an expansion carrying characters JSON must escape.
 */
function loadedCodec(): ArgotSession {
	const vocab: Vocabulary = {
		version: 1,
		sigil: "§",
		handles: new Map([
			["db", "src/db.ts"],
			["dbconn", "packages/server/src/database/connection.ts"],
			["quoted", 'say "hi"\nthen\\stop'],
		]),
		meta: new Map(),
	};
	const codec = new ArgotSession();
	codec.loadVocab(vocab);
	return codec;
}

/** A tool-call block, optionally carrying streamed argument JSON. */
function toolCall(args: Record<string, unknown>, partialJson?: string): AssistantMessage["content"][number] {
	const block = { type: "toolCall", id: "t1", name: "write", arguments: args };
	if (partialJson !== undefined) setStreamingPartialJson(block, partialJson);
	return block as AssistantMessage["content"][number];
}

/** The `arguments` of the first block of a decoded content array. */
function decodedArgs(content: AssistantMessage["content"]): Record<string, unknown> {
	const block = content[0] as { arguments?: Record<string, unknown> };
	return block.arguments ?? {};
}

describe("tool-call arguments in the live preview", () => {
	/**
	 * The plain case: a handle in a parsed argument value is shown expanded. This
	 * is what a `read` call looks like on screen, and it used to show `§db`.
	 */
	it("expands a handle in a parsed argument value", () => {
		const decoder = new ArgotStreamDisplayDecoder(loadedCodec());
		const out = decoder.decodeContent([toolCall({ path: "§db ", mode: "w" })]);
		expect(decodedArgs(out).path).toBe("src/db.ts ");
		expect(decodedArgs(out).mode).toBe("w");
	});

	/** Nested values are reached too: a handle does not stop being one inside an array or object. */
	it("expands handles nested in arrays and objects", () => {
		const decoder = new ArgotStreamDisplayDecoder(loadedCodec());
		const out = decoder.decodeContent([toolCall({ edits: [{ file: "§db " }], also: { at: "§dbconn " } })]);
		const args = decodedArgs(out) as { edits: { file: string }[]; also: { at: string } };
		expect(args.edits[0].file).toBe("src/db.ts ");
		expect(args.also.at).toBe("packages/server/src/database/connection.ts ");
	});

	/**
	 * The block is returned by reference when it carries no handle. The arguments
	 * of a large `write` are re-examined on every stream update, so the no-handle
	 * path has to stay a single scan and allocate nothing.
	 */
	it("returns a handle-free tool call by reference", () => {
		const decoder = new ArgotStreamDisplayDecoder(loadedCodec());
		const block = toolCall({ path: "src/main.ts", content: "nothing to expand" });
		expect(decoder.decodeContent([block])[0]).toBe(block);
	});

	/** Argot off must not perturb the block at all, not even into a copy. */
	it("is inert with no codec", () => {
		const block = toolCall({ path: "§db" });
		const content = [block];
		expect(new ArgotStreamDisplayDecoder(undefined).decodeContent(content)).toBe(content);
	});

	/**
	 * A value still being streamed can end mid-handle. Expanding it as-is would
	 * either leak `§d` or fire the shorter `§db` before `§dbconn` finished, so the
	 * ambiguous tail is withheld until the next snapshot settles it. A briefly
	 * missing tail is invisible on screen; a briefly visible `§db` is not, and a
	 * wrong expansion that then changes is worse than both.
	 */
	it("withholds a value's trailing fragment rather than showing or mis-expanding a partial handle", () => {
		const decoder = new ArgotStreamDisplayDecoder(loadedCodec());
		const midName = decodedArgs(decoder.decodeContent([toolCall({ path: "open §d" })]));
		expect(midName.path).toBe("open ");
		const settled = decodedArgs(decoder.decodeContent([toolCall({ path: "open §dbconn " })]));
		expect(settled.path).toBe("open packages/server/src/database/connection.ts ");
	});
});

describe("streamed tool-call argument JSON", () => {
	/**
	 * The view the live reveal actually reads while the arguments object is still
	 * incomplete. Decoding only the parsed object left this raw, which is why a
	 * streaming `write` preview showed handles for its whole duration.
	 */
	it("expands a handle inside the streamed argument JSON", () => {
		const decoder = new ArgotStreamDisplayDecoder(loadedCodec());
		const out = decoder.decodeContent([toolCall({}, '{"path":"§db ","content":"x')]);
		expect(getStreamingPartialJson(out[0] as object)).toBe('{"path":"src/db.ts ","content":"x');
	});

	/**
	 * The safety property. An expansion holding a quote, a newline or a backslash
	 * spliced in verbatim would end the JSON string literal early and break the
	 * parse the preview depends on, turning a cosmetic bug into a blank preview.
	 * Asserting through `JSON.parse` proves the replacement is escaped for the
	 * context it lands in, and that the parsed value is the real expansion.
	 */
	it("keeps the JSON parseable when an expansion contains quotes, newlines or backslashes", () => {
		const decoder = new ArgotStreamDisplayDecoder(loadedCodec());
		const out = decoder.decodeContent([toolCall({}, '{"content":"§quoted "}')]);
		const json = getStreamingPartialJson(out[0] as object) ?? "";
		expect(() => JSON.parse(json)).not.toThrow();
		expect(JSON.parse(json)).toEqual({ content: 'say "hi"\nthen\\stop ' });
	});

	/**
	 * The prefix grows one chunk at a time and a handle can straddle two chunks,
	 * exactly as in the text stream. Decoding each snapshot independently would
	 * emit the shorter `§db` and then have to take it back.
	 */
	it("never shows a raw or prematurely expanded handle as the prefix grows", () => {
		const decoder = new ArgotStreamDisplayDecoder(loadedCodec());
		const seen = ['{"path":"open §d', "b", 'conn ","x":1}'].reduce<string[]>((acc, chunk) => {
			const prefix = (acc.at(-1) === undefined ? "" : acc.at(-1)) + chunk;
			acc.push(prefix);
			return acc;
		}, []);
		const rendered = seen.map(
			prefix => getStreamingPartialJson(decoder.decodeContent([toolCall({}, prefix)])[0] as object) ?? "",
		);
		for (const view of rendered) expect(view).not.toContain("§");
		expect(rendered.at(-1)).toBe('{"path":"open packages/server/src/database/connection.ts ","x":1}');
		// The shorter handle never appears: it was never the right answer.
		for (const view of rendered) expect(view).not.toContain("src/db.ts");
	});

	/**
	 * A provider that re-sends a rewritten prefix rather than an extension of the
	 * last one must still decode correctly. Feeding the difference blindly would
	 * splice two unrelated prefixes together, so a non-extending snapshot restarts
	 * the decode.
	 */
	it("re-decodes from scratch when a snapshot is not an extension of the previous one", () => {
		const decoder = new ArgotStreamDisplayDecoder(loadedCodec());
		decoder.decodeContent([toolCall({}, '{"path":"§dbconn ","a":1}')]);
		const out = decoder.decodeContent([toolCall({}, '{"other":"§db "}')]);
		expect(getStreamingPartialJson(out[0] as object)).toBe('{"other":"src/db.ts "}');
	});

	/**
	 * A custom-wire tool streams its payload verbatim, not as JSON, so its
	 * expansion must NOT be JSON-escaped.
	 *
	 * `apply_patch` on OpenAI's custom-tool path sends a patch body. Escaping an
	 * expansion there would put the two characters backslash-n into the patch
	 * where a newline belongs, and the patch would stop applying: a display fix
	 * that silently breaks the tool. `customWireName` on the block is what tells
	 * the two encodings apart, so it is asserted directly rather than inferred
	 * from the tool's name.
	 */
	it("expands verbatim, without JSON escaping, for a custom-wire tool call", () => {
		const decoder = new ArgotStreamDisplayDecoder(loadedCodec());
		const block = { type: "toolCall", id: "t1", name: "apply_patch", arguments: {}, customWireName: "apply_patch" };
		setStreamingPartialJson(block, "*** Begin Patch\n§quoted \n*** End Patch");
		const out = decoder.decodeContent([block as unknown as AssistantMessage["content"][number]]);
		const payload = getStreamingPartialJson(out[0] as object) ?? "";
		expect(payload).toBe('*** Begin Patch\nsay "hi"\nthen\\stop \n*** End Patch');
		expect(payload).not.toContain("\\n");
	});

	/** Handle-free JSON is left exactly as it arrived, symbol and all. */
	it("leaves handle-free streamed JSON untouched", () => {
		const decoder = new ArgotStreamDisplayDecoder(loadedCodec());
		const block = toolCall({ path: "src/main.ts" }, '{"path":"src/main.ts"}');
		expect(decoder.decodeContent([block])[0]).toBe(block);
	});

	/**
	 * Two tool calls in one message decode independently. Sharing one decoder
	 * across content indices would let one call's held fragment surface in the
	 * other's preview.
	 */
	it("tracks streamed JSON separately per content index", () => {
		const decoder = new ArgotStreamDisplayDecoder(loadedCodec());
		const first = toolCall({}, '{"a":"§db ');
		const second = toolCall({}, '{"b":"§dbconn ');
		const out = decoder.decodeContent([first, second]);
		expect(getStreamingPartialJson(out[0] as object)).toBe('{"a":"src/db.ts ');
		expect(getStreamingPartialJson(out[1] as object)).toBe('{"b":"packages/server/src/database/connection.ts ');
	});

	/**
	 * `flush` ends the message. The next message reuses the decoder object, so any
	 * prefix state left behind would make the first snapshot of the next call
	 * decode against a stale prefix.
	 */
	it("drops streamed-JSON state at flush so the next message starts clean", () => {
		const decoder = new ArgotStreamDisplayDecoder(loadedCodec());
		decoder.decodeContent([toolCall({}, '{"a":"§db ')]);
		decoder.flush();
		const out = decoder.decodeContent([toolCall({}, '{"a":"§dbconn ')]);
		expect(getStreamingPartialJson(out[0] as object)).toBe('{"a":"packages/server/src/database/connection.ts ');
	});
});
