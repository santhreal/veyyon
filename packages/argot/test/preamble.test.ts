import { describe, expect, test } from "bun:test";
import { ARGOT_LOAD_TOOL, ARGOT_UNLOAD_TOOL, DEFAULT_SIGIL, DICT_FILENAME } from "../src/constants.js";
import { ARGOT_PREAMBLE, renderPreamble } from "../src/preamble.js";

describe("ARGOT_PREAMBLE (passive default)", () => {
	test("names the dictionary file so the model knows what to read", () => {
		expect(ARGOT_PREAMBLE).toContain(DICT_FILENAME);
	});

	test("states the default sigil and shows the handle form", () => {
		expect(ARGOT_PREAMBLE).toContain(DEFAULT_SIGIL);
		expect(ARGOT_PREAMBLE).toContain(`${DEFAULT_SIGIL}dbconn`);
	});

	test("tells the model handles are lossless and not to invent them", () => {
		expect(ARGOT_PREAMBLE.toLowerCase()).toContain("lossless");
		expect(ARGOT_PREAMBLE.toLowerCase()).toContain("never invent");
	});

	test("gives the model a reason to adopt: a handle makes output shorter at no cost to meaning", () => {
		// Adoption is the whole point. A purely descriptive block ("here is the
		// notation") gave the model no motive to prefer the handle, and the
		// edit-benchmark measured zero organic use. The block must state the reason
		// out loud: the handle is shorter and the harness restores the full text, so
		// there is no accuracy trade-off. If this regresses, the preamble is back to
		// describing the mechanism without inviting its use.
		// Normalize whitespace: the phrase may wrap across a line break in the block.
		const flat = ARGOT_PREAMBLE.toLowerCase().replace(/\s+/g, " ");
		expect(flat).toContain("prefer a handle over the string it stands for");
		expect(flat).toContain("shorter");
	});

	test("shows a worked substitution so the model sees a handle used, not just described", () => {
		// A concrete example is the strongest adoption nudge: the model needs to see
		// a real string replaced by its handle in a sentence, not only an abstract
		// rule. The example uses the same §dbconn -> connection.ts binding the SPEC
		// and README use, so the notation is illustrated identically everywhere. If
		// the example is dropped, the block loses its most effective teaching signal.
		expect(ARGOT_PREAMBLE).toContain("packages/server/src/database/connection.ts");
		// The example must actually pair that path with the handle that stands for it.
		const exampleStart = ARGOT_PREAMBLE.indexOf("For example");
		expect(exampleStart).toBeGreaterThan(-1);
		const example = ARGOT_PREAMBLE.slice(exampleStart);
		expect(example).toContain(`${DEFAULT_SIGIL}dbconn`);
		expect(example).toContain("packages/server/src/database/connection.ts");
	});

	test("teaches the narrowest-work-unit rule so a monorepo parent is not loaded", () => {
		// The whole point of scoping: an agent in a crate inside Santh must use the
		// crate's handles, never the enclosing monorepo's. If this instruction
		// regresses, multi-project contexts load the wrong (or too-broad) vocabulary.
		expect(ARGOT_PREAMBLE.toLowerCase()).toContain("narrowest project");
	});

	test("is the tools-off rendering, so it must not name the load/unload tools", () => {
		// A model with no argot_load tool must not be told to call it. This proves
		// the default stays silent about affordances the harness has not exposed.
		expect(ARGOT_PREAMBLE).not.toContain(ARGOT_LOAD_TOOL);
		expect(ARGOT_PREAMBLE).not.toContain(ARGOT_UNLOAD_TOOL);
	});

	test("equals renderPreamble with tools off", () => {
		expect(ARGOT_PREAMBLE).toBe(renderPreamble({ tools: false }));
		expect(ARGOT_PREAMBLE).toBe(renderPreamble());
	});

	test("is a non-trivial, stable block of instruction", () => {
		expect(ARGOT_PREAMBLE.length).toBeGreaterThan(200);
	});
});

describe("renderPreamble({ tools: true })", () => {
	test("names both tools by their canonical names so the model can call them", () => {
		// The block may only advertise a tool the harness actually registered, and it
		// must use the exact registered name; a mismatch means the model calls a name
		// that does not resolve.
		const block = renderPreamble({ tools: true });
		expect(block).toContain(`${ARGOT_LOAD_TOOL}(folder_path)`);
		expect(block).toContain(`${ARGOT_UNLOAD_TOOL}(folder_path)`);
	});

	test("still teaches the notation, losslessness, and the narrowest-work-unit rule", () => {
		const block = renderPreamble({ tools: true });
		expect(block).toContain(`${DEFAULT_SIGIL}dbconn`);
		expect(block.toLowerCase()).toContain("lossless");
		expect(block.toLowerCase()).toContain("never invent");
		expect(block.toLowerCase()).toContain("narrowest project");
	});

	test("carries the same adoption reason and worked example as the passive default", () => {
		// The invitation to adopt is not tools-dependent, so both renderings must
		// motivate use and show the worked substitution; only the "how you learn the
		// handles" sentence differs between them.
		const block = renderPreamble({ tools: true }).toLowerCase().replace(/\s+/g, " ");
		expect(block).toContain("prefer a handle over the string it stands for");
		expect(block).toContain("packages/server/src/database/connection.ts");
	});

	test("says unloading keeps already-written handles readable", () => {
		// Encode/decode asymmetry surfaced to the model: unload stops teaching but
		// never breaks a handle already written.
		expect(renderPreamble({ tools: true }).toLowerCase()).toContain("still reads back correctly");
	});
});
