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

	test("says unloading keeps already-written handles readable", () => {
		// Encode/decode asymmetry surfaced to the model: unload stops teaching but
		// never breaks a handle already written.
		expect(renderPreamble({ tools: true }).toLowerCase()).toContain("still reads back correctly");
	});
});
