/**
 * A streaming tool-call preview shows the text a handle stands for, not the handle.
 *
 * WHY THIS EXISTS. Argot replaces long repeated strings on the wire with `§handle` fragments and expands
 * them back at the seams. Seam 1 is `expandToolArguments`, and it runs just before a tool EXECUTES. The
 * streaming preview draws arguments that have not reached that seam yet, so for the whole time a call
 * streams the operator watched a `write` preview whose body was `§db` and an `edit` preview whose input was a
 * handle name. Nothing was broken and nothing was reported: the tool ran on the right text, the screen simply
 * showed the wire form.
 *
 * WHAT THE FIX MAY NOT DO, and it is the reason this suite asserts structure rather than substrings. A handle
 * can expand to text containing `"`, `\` or a newline. The buffer being previewed is PARTIAL JSON, so
 * expanding it as text would splice those bytes inside the string literal they sit in and corrupt the JSON the
 * next frame has to parse. Expansion therefore happens strictly after a value leaves the partial-JSON layer:
 * on parsed values, on the incremental string extractor's values, and on a custom tool's raw text, which is
 * not JSON at all. The raw `__partialJson` buffer of a function tool stays raw, and that is asserted too,
 * because "expand everything" is the obvious wrong fix and it passes every test that only greps for the
 * expansion.
 *
 * THE INERT PATH IS THE OTHER HALF. Argot is off by default. Every case below has a twin with no codec or an
 * unloaded one, because a decode path that changed shape when the feature is disabled would be a regression
 * for every user who never turns it on.
 */

import { describe, expect, it } from "bun:test";
import { decodeStreamedToolArgs } from "@veyyon/coding-agent/modes/controllers/tool-args-reveal";
import { ArgotSession, type Vocabulary } from "argot";

/** A real, loaded codec. `§db` is a path, `§blob` expands to text that would break naive JSON splicing. */
function loadedCodec(): ArgotSession {
	const vocab: Vocabulary = {
		version: 1,
		sigil: "§",
		handles: new Map([
			["db", "src/db.ts"],
			["blob", 'a "quoted" line\nand a \\ backslash'],
		]),
		meta: new Map(),
	};
	const codec = new ArgotSession();
	codec.loadVocab(vocab);
	return codec;
}

/** A codec with no dictionary: every seam must be identity. */
function unloadedCodec(): ArgotSession {
	return new ArgotSession();
}

describe("parsed argument values are expanded", () => {
	/**
	 * The headline case: a complete `write` call whose content is a handle. Before the fix the preview drew
	 * `§db` for as long as the call streamed, and it drew it correctly, which is why nothing caught it.
	 */
	it("expands a handle in a value the parse recovered", () => {
		const buffer = '{"path":"a.ts","content":"§db"}';

		const args = decodeStreamedToolArgs(buffer, { rawInput: false, argot: loadedCodec() });

		expect(args.content).toBe("src/db.ts");
		expect(args.path).toBe("a.ts");
	});

	/**
	 * Handles are substrings, not whole values. A body that mentions a handle mid-sentence has to come back
	 * with the handle replaced in place and the rest of the text untouched.
	 */
	it("expands a handle embedded in a longer value", () => {
		const buffer = '{"content":"see §db for the schema"}';

		const args = decodeStreamedToolArgs(buffer, { rawInput: false, argot: loadedCodec() });

		expect(args.content).toBe("see src/db.ts for the schema");
	});

	/**
	 * THE CONSTRAINT, asserted directly. `§blob` expands to text with a quote, a newline and a backslash in
	 * it. If expansion had been applied to the buffer instead of the value, the result would be a broken
	 * JSON string and the parse would either fail or recover the wrong text. The expanded value must arrive
	 * intact, byte for byte.
	 */
	it("expands to text containing quotes, newlines and backslashes without corrupting the parse", () => {
		const buffer = '{"path":"a.ts","content":"§blob"}';

		const args = decodeStreamedToolArgs(buffer, { rawInput: false, argot: loadedCodec() });

		expect(args.content).toBe('a "quoted" line\nand a \\ backslash');
		// The neighbouring key survived, which is what proves the structure was not spliced.
		expect(args.path).toBe("a.ts");
	});

	/** Unknown handles are left alone rather than blanked: an unknown name is text, not an error. */
	it("leaves a handle the dictionary does not know", () => {
		const buffer = '{"content":"§notInTheDictionary"}';

		const args = decodeStreamedToolArgs(buffer, { rawInput: false, argot: loadedCodec() });

		expect(args.content).toBe("§notInTheDictionary");
	});

	/**
	 * Values that never held a handle pass through unchanged, so nothing about the preview of an ordinary
	 * call moves when the feature is on.
	 */
	it("leaves ordinary values untouched", () => {
		const buffer = '{"path":"src/index.ts","content":"export const x = 1;"}';

		const args = decodeStreamedToolArgs(buffer, { rawInput: false, argot: loadedCodec() });

		expect(args.path).toBe("src/index.ts");
		expect(args.content).toBe("export const x = 1;");
	});
});

describe("the raw JSON buffer is never expanded", () => {
	/**
	 * `__partialJson` is the raw prefix, and the renderers that read it slice fields out of it themselves.
	 * It has to stay exactly as received: this is the assertion that fails if someone "simplifies" the fix
	 * by expanding the buffer, which would pass every case in the block above.
	 */
	it("hands back the buffer byte for byte", () => {
		const buffer = '{"path":"a.ts","content":"§db';

		const args = decodeStreamedToolArgs(buffer, { rawInput: false, argot: loadedCodec() });

		expect(args.__partialJson).toBe(buffer);
	});

	/** And the same for a buffer whose handle expands to JSON-hostile text, which is the dangerous one. */
	it("hands back a buffer whose handle would break the JSON if expanded", () => {
		const buffer = '{"content":"§blob"}';

		const args = decodeStreamedToolArgs(buffer, { rawInput: false, argot: loadedCodec() });

		expect(args.__partialJson).toBe(buffer);
		expect(args.__partialJson).not.toContain("quoted");
	});
});

describe("a partial buffer is still previewed", () => {
	/**
	 * A tool call arrives in fragments, so most frames see JSON that is not closed yet. The incremental
	 * string extractor is what keeps a long `write` body fresh between throttled full parses, and its values
	 * go through the same expansion as the parsed ones.
	 */
	it("expands a streamed string field before the JSON closes", () => {
		const buffer = '{"path":"a.ts","content":"the schema is in §db';

		const args = decodeStreamedToolArgs(buffer, {
			rawInput: false,
			streamingStringKeys: ["content"],
			argot: loadedCodec(),
		});

		expect(args.content).toBe("the schema is in src/db.ts");
	});

	/**
	 * A handle split across the buffer's edge stays raw for one frame and resolves on the next, which is the
	 * documented behaviour rather than a gap: the rest of the handle has not been received. Both frames are
	 * asserted so the transition is pinned and not merely described.
	 */
	it("holds a handle cut in half, and resolves it on the next frame", () => {
		const argot = loadedCodec();
		const halfway = decodeStreamedToolArgs('{"content":"§d', {
			rawInput: false,
			streamingStringKeys: ["content"],
			argot,
		});
		expect(halfway.content).toBe("§d");

		const complete = decodeStreamedToolArgs('{"content":"§db"}', {
			rawInput: false,
			streamingStringKeys: ["content"],
			argot,
		});
		expect(complete.content).toBe("src/db.ts");
	});
});

describe("a custom tool's raw text stream", () => {
	/**
	 * Custom tools stream raw TEXT in the same transport field, so there is no JSON to protect and both
	 * `input` and `__partialJson` are values. Expanding `__partialJson` here is required rather than merely
	 * safe: `tool-execution.ts` recovers a missing `input` from that exact field.
	 */
	it("expands both the input and the buffer, because neither is JSON", () => {
		const args = decodeStreamedToolArgs("look at §db please", { rawInput: true, argot: loadedCodec() });

		expect(args.input).toBe("look at src/db.ts please");
		expect(args.__partialJson).toBe("look at src/db.ts please");
	});
});

describe("the inert path is byte-identical", () => {
	/**
	 * Argot is off by default, so the no-codec path is the one almost every session takes. A decode that
	 * changed anything here would be a regression for every user who never enables the feature.
	 */
	it("changes nothing when no codec is supplied", () => {
		const buffer = '{"path":"a.ts","content":"§db"}';

		const args = decodeStreamedToolArgs(buffer, { rawInput: false });

		expect(args.content).toBe("§db");
		expect(args.__partialJson).toBe(buffer);
	});

	/**
	 * And an ARMED but unloaded codec is identity too. This is the guard the whole design rests on: the
	 * decode path calls the expansion unconditionally, so "identity until a dictionary loads" is what makes
	 * that unconditional call safe.
	 */
	it("changes nothing when the codec has no dictionary", () => {
		const buffer = '{"content":"§db"}';

		const args = decodeStreamedToolArgs(buffer, { rawInput: false, argot: unloadedCodec() });

		expect(args.content).toBe("§db");
		expect(args.__partialJson).toBe(buffer);
	});

	/** The raw-text branch has its own inert twin, since it takes a different code path entirely. */
	it("changes nothing on a raw text stream without a codec", () => {
		const args = decodeStreamedToolArgs("look at §db please", { rawInput: true });

		expect(args.input).toBe("look at §db please");
		expect(args.__partialJson).toBe("look at §db please");
	});
});

describe("provider-parsed arguments and the fresh decode", () => {
	/**
	 * `fullArgs` is the provider's own parse, spread UNDER the fresh one. It arrives already expanded on the
	 * paths that expand it, and it must not be double-expanded into something else, so a value that merely
	 * LOOKS like an expansion has to survive.
	 */
	it("keeps a provider value the fresh parse did not recover", () => {
		const args = decodeStreamedToolArgs('{"content":"§db"}', {
			rawInput: false,
			fullArgs: { path: "src/db.ts", content: "stale" },
			argot: loadedCodec(),
		});

		expect(args.path).toBe("src/db.ts");
		// The fresh parse wins for a key it recovered, and it is the expanded form.
		expect(args.content).toBe("src/db.ts");
	});
});
