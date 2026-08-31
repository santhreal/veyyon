import { describe, expect, it } from "bun:test";
import { ARGOT_LOAD_TOOL, ARGOT_UNLOAD_TOOL, DICT_FILENAME } from "../src/constants";
import { ARGOT_PREAMBLE, renderPreamble } from "../src/preamble";

describe("renderPreamble", () => {
	it("returns a non-empty string", () => {
		expect(renderPreamble().length).toBeGreaterThan(0);
	});
	it("contains 'Project shorthand' heading", () => {
		expect(renderPreamble()).toContain("## Project shorthand (Argot)");
	});
	it("contains sigil example", () => {
		expect(renderPreamble()).toContain("§dbconn");
	});
	it("default (no tools) mentions DICT_FILENAME", () => {
		expect(renderPreamble()).toContain(DICT_FILENAME);
	});
	it("default (no tools) does not mention load tool", () => {
		expect(renderPreamble()).not.toContain(ARGOT_LOAD_TOOL);
	});
	it("default (no tools) does not mention unload tool", () => {
		expect(renderPreamble()).not.toContain(ARGOT_UNLOAD_TOOL);
	});
	it("with tools=true mentions load tool", () => {
		expect(renderPreamble({ tools: true })).toContain(ARGOT_LOAD_TOOL);
	});
	it("with tools=true mentions unload tool", () => {
		expect(renderPreamble({ tools: true })).toContain(ARGOT_UNLOAD_TOOL);
	});
	it("with tools=true does not mention DICT_FILENAME", () => {
		expect(renderPreamble({ tools: true })).not.toContain(DICT_FILENAME);
	});
	it("with tools=false mentions DICT_FILENAME", () => {
		expect(renderPreamble({ tools: false })).toContain(DICT_FILENAME);
	});
	it("with tools=false does not mention load tool", () => {
		expect(renderPreamble({ tools: false })).not.toContain(ARGOT_LOAD_TOOL);
	});
	it("mentions 'lossless'", () => {
		expect(renderPreamble()).toContain("lossless");
	});
	it("mentions 'scoped to a single project'", () => {
		expect(renderPreamble()).toContain("scoped to a single project");
	});
	it("tools variant mentions folder_path", () => {
		expect(renderPreamble({ tools: true })).toContain("folder_path");
	});
	it("default variant does not mention folder_path", () => {
		expect(renderPreamble()).not.toContain("folder_path");
	});
});

describe("ARGOT_PREAMBLE", () => {
	it("is a non-empty string", () => {
		expect(typeof ARGOT_PREAMBLE).toBe("string");
		expect(ARGOT_PREAMBLE.length).toBeGreaterThan(0);
	});
	it("equals renderPreamble() with no args", () => {
		expect(ARGOT_PREAMBLE).toBe(renderPreamble());
	});
});
