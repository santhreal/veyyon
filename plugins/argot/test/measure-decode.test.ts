/**
 * Instrumented decode (`measureDecode`): the measurement primitive an adoption
 * benchmark stands on. These tests lock two contracts that make the benchmark
 * trustworthy:
 *
 *  1. PARITY — `measureDecode(vocab, text).expanded` is byte-identical to
 *     `makeExpander(vocab)(text)` for every input. If this ever diverged, the
 *     benchmark would be measuring a different decode than production runs, so the
 *     numbers would be a lie. Both are built from the one `buildHandlePattern`.
 *  2. TRUTHFUL COUNTS — `replacements.length` is exactly the number of known
 *     handles the model emitted (adoption), and `unknownSigilCount` is exactly the
 *     number of sigils that did NOT resolve to a handle (lossy raw-shorthand
 *     leaks). A green adoption bench must be unable to pass on a transcript that
 *     leaks a raw sigil, so this count has to be exact, not approximate.
 */
import { describe, expect, test } from "bun:test";
import { makeExpander, measureDecode } from "../src/codec.js";
import { DEFAULT_SIGIL } from "../src/constants.js";
import { parseDict } from "../src/parse.js";
import type { Vocabulary } from "../src/types.js";

const BASE = `version = 1
[handles]
dbconn = "packages/server/src/database/connection.ts"
db = "packages/server/src/database"
svc = "the checkout service"
`;

const VOCAB = parseDict(BASE, "AGENTS.dict");

describe("measureDecode parity with makeExpander", () => {
	const expand = makeExpander(VOCAB);
	const cases = [
		"open §dbconn now",
		"§dbconn",
		"§db",
		"§dbextra",
		"§db§svc",
		"restart §svc at §dbconn and §nope",
		"no handles here at all",
		"",
		"§§svc double sigil",
	];
	for (const text of cases) {
		test(`expanded matches makeExpander for ${JSON.stringify(text)}`, () => {
			expect(measureDecode(VOCAB, text).expanded).toBe(expand(text));
		});
	}
});

describe("measureDecode adoption count (replacements)", () => {
	test("counts each known-handle emission once, in order, with name/expansion/index", () => {
		const text = "connect to §dbconn then restart §svc";
		const m = measureDecode(VOCAB, text);
		expect(m.replacements.map(r => r.name)).toEqual(["dbconn", "svc"]);
		expect(m.replacements[0]!.expansion).toBe("packages/server/src/database/connection.ts");
		expect(m.replacements[0]!.index).toBe(text.indexOf("§dbconn"));
		expect(m.replacements[1]!.expansion).toBe("the checkout service");
		expect(m.replacements[1]!.index).toBe(text.indexOf("§svc"));
	});

	test("counts repeated use of the same handle as separate emissions", () => {
		const m = measureDecode(VOCAB, "§svc §svc §svc");
		expect(m.replacements).toHaveLength(3);
		expect(m.replacements.every(r => r.name === "svc")).toBe(true);
		expect(m.unknownSigilCount).toBe(0);
	});

	test("prefers the longest handle at a boundary (dbconn, not db)", () => {
		const m = measureDecode(VOCAB, "§dbconn");
		expect(m.replacements).toHaveLength(1);
		expect(m.replacements[0]!.name).toBe("dbconn");
		expect(m.unknownSigilCount).toBe(0);
	});

	test("counts adjacent handles with no separator as two emissions", () => {
		const m = measureDecode(VOCAB, "§db§svc");
		expect(m.replacements.map(r => r.name)).toEqual(["db", "svc"]);
		expect(m.expanded).toBe("packages/server/src/databasethe checkout service");
		expect(m.unknownSigilCount).toBe(0);
	});
});

describe("measureDecode unknown-sigil leaks", () => {
	test("a hallucinated handle name is an unresolved sigil, not an expansion", () => {
		const m = measureDecode(VOCAB, "use §nope here");
		expect(m.replacements).toHaveLength(0);
		expect(m.unknownSigilCount).toBe(1);
		// It survives verbatim into the expanded text: a raw-shorthand leak.
		expect(m.expanded).toBe("use §nope here");
	});

	test("the boundary guard makes §dbextra an unresolved sigil (db is a handle, dbextra is not)", () => {
		const m = measureDecode(VOCAB, "§dbextra");
		expect(m.replacements).toHaveLength(0);
		expect(m.unknownSigilCount).toBe(1);
		expect(m.expanded).toBe("§dbextra");
	});

	test("separates real adoption from a leak in the same string", () => {
		const m = measureDecode(VOCAB, "§svc and §mystery");
		expect(m.replacements.map(r => r.name)).toEqual(["svc"]);
		expect(m.unknownSigilCount).toBe(1);
	});

	test("a doubled sigil §§svc leaves one leaked sigil and one real emission", () => {
		// §§svc: the first § is followed by "§svc" (not a name char run), so it does
		// not form a handle; the second §svc expands. One leak, one adoption.
		const m = measureDecode(VOCAB, "§§svc");
		expect(m.replacements.map(r => r.name)).toEqual(["svc"]);
		expect(m.unknownSigilCount).toBe(1);
	});
});

describe("measureDecode with an empty vocabulary", () => {
	test("is identity, reports zero adoption, and counts every sigil as a leak", () => {
		// parseDict refuses a zero-handle dict, so build the inert vocabulary directly.
		const empty: Vocabulary = { version: 1, sigil: DEFAULT_SIGIL, handles: new Map(), meta: new Map() };
		const m = measureDecode(empty, "text §a §b with §c sigils");
		expect(m.expanded).toBe("text §a §b with §c sigils");
		expect(m.replacements).toHaveLength(0);
		expect(m.unknownSigilCount).toBe(3);
	});
});
