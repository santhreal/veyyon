import { describe, expect, it } from "bun:test";
import { ARGOT_LOAD_TOOL, ARGOT_UNLOAD_TOOL, DICT_FILENAME } from "../src/constants";
import { ARGOT_PREAMBLE, renderPreamble } from "../src/preamble";

describe("renderPreamble", () => {
	it("returns non-empty string by default", () => {
		expect(renderPreamble().length).toBeGreaterThan(0);
	});
	it("contains Argot heading", () => {
		expect(renderPreamble()).toContain("Project shorthand (Argot)");
	});
	it("contains sigil example", () => {
		expect(renderPreamble()).toContain("§");
	});
	it("contains dbconn example", () => {
		expect(renderPreamble()).toContain("§dbconn");
	});
	it("mentions lossless", () => {
		expect(renderPreamble()).toContain("lossless");
	});
	it("mentions scoped to project", () => {
		expect(renderPreamble()).toContain("scoped");
	});
	it("without tools, mentions DICT_FILENAME", () => {
		expect(renderPreamble()).toContain(DICT_FILENAME);
	});
	it("without tools, does not mention load tool", () => {
		expect(renderPreamble()).not.toContain(ARGOT_LOAD_TOOL);
	});
	it("with tools=true, mentions load tool", () => {
		expect(renderPreamble({ tools: true })).toContain(ARGOT_LOAD_TOOL);
	});
	it("with tools=true, mentions unload tool", () => {
		expect(renderPreamble({ tools: true })).toContain(ARGOT_UNLOAD_TOOL);
	});
	it("with tools=true, does not mention DICT_FILENAME approach", () => {
		const withTools = renderPreamble({ tools: true });
		// The tools variant mentions the tool, not the file-based approach
		expect(withTools).toContain(ARGOT_LOAD_TOOL);
	});
	it("with tools=false, matches default", () => {
		expect(renderPreamble({ tools: false })).toBe(renderPreamble());
	});
	it("with tools=true, mentions folder_path", () => {
		expect(renderPreamble({ tools: true })).toContain("folder_path");
	});
	it("mentions harness restores handles", () => {
		expect(renderPreamble()).toContain("restores");
	});
});

describe("ARGOT_PREAMBLE constant", () => {
	it("is a non-empty string", () => {
		expect(typeof ARGOT_PREAMBLE).toBe("string");
		expect(ARGOT_PREAMBLE.length).toBeGreaterThan(0);
	});
	it("equals renderPreamble() with default options", () => {
		expect(ARGOT_PREAMBLE).toBe(renderPreamble());
	});
});
