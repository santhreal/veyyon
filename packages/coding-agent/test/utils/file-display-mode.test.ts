import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveFileDisplayMode } from "@veyyon/coding-agent/utils/file-display-mode";

/**
 * resolveFileDisplayMode decides, for every file-like output (read, grep, @file
 * mention), whether to emit line numbers and hashline edit anchors. It had no test.
 * The precedence rules are subtle and a silent flip changes output format app-wide:
 * hashline mode implies line numbers, but is suppressed when the edit tool is
 * absent (scout agents), for a `raw` read, and for an `immutable` source; a `raw`
 * read suppresses line numbers outright; otherwise line numbers follow the
 * readLineNumbers setting. These pin every branch of that truth table.
 *
 * VEYYON_EDIT_VARIANT / VEYYON_STRICT_EDIT_MODE are cleared per test so the
 * environment cannot leak an edit mode into resolveEditMode and make this flaky.
 */

interface Over {
	hasEditTool?: boolean;
	editMode?: string;
	readLineNumbers?: boolean;
}

function session(over: Over) {
	return {
		hasEditTool: over.hasEditTool,
		settings: {
			get(key: "readLineNumbers" | "edit.mode"): unknown {
				if (key === "edit.mode") return over.editMode;
				if (key === "readLineNumbers") return over.readLineNumbers;
				return undefined;
			},
		},
	};
}

let savedVariant: string | undefined;
let savedStrict: string | undefined;

beforeEach(() => {
	savedVariant = process.env.VEYYON_EDIT_VARIANT;
	savedStrict = process.env.VEYYON_STRICT_EDIT_MODE;
	delete process.env.VEYYON_EDIT_VARIANT;
	delete process.env.VEYYON_STRICT_EDIT_MODE;
});
afterEach(() => {
	if (savedVariant === undefined) delete process.env.VEYYON_EDIT_VARIANT;
	else process.env.VEYYON_EDIT_VARIANT = savedVariant;
	if (savedStrict === undefined) delete process.env.VEYYON_STRICT_EDIT_MODE;
	else process.env.VEYYON_STRICT_EDIT_MODE = savedStrict;
});

describe("resolveFileDisplayMode — hashline mode", () => {
	it("emits hashlines and line numbers when hashline mode is active with the edit tool", () => {
		expect(resolveFileDisplayMode(session({ editMode: "hashline", hasEditTool: true }))).toEqual({
			hashLines: true,
			lineNumbers: true,
		});
	});

	it("implies line numbers even when readLineNumbers is false", () => {
		expect(resolveFileDisplayMode(session({ editMode: "hashline", readLineNumbers: false }))).toEqual({
			hashLines: true,
			lineNumbers: true,
		});
	});

	it("defaults hasEditTool to true when the session omits it", () => {
		expect(resolveFileDisplayMode(session({ editMode: "hashline" }))).toEqual({
			hashLines: true,
			lineNumbers: true,
		});
	});
});

describe("resolveFileDisplayMode — hashline suppression", () => {
	it("suppresses hashlines when the edit tool is unavailable", () => {
		expect(resolveFileDisplayMode(session({ editMode: "hashline", hasEditTool: false }))).toEqual({
			hashLines: false,
			lineNumbers: false,
		});
	});

	it("keeps line numbers when the edit tool is absent but readLineNumbers is on", () => {
		expect(
			resolveFileDisplayMode(session({ editMode: "hashline", hasEditTool: false, readLineNumbers: true })),
		).toEqual({ hashLines: false, lineNumbers: true });
	});

	it("suppresses hashlines for an immutable source but honors readLineNumbers", () => {
		expect(resolveFileDisplayMode(session({ editMode: "hashline" }), { immutable: true })).toEqual({
			hashLines: false,
			lineNumbers: false,
		});
		expect(
			resolveFileDisplayMode(session({ editMode: "hashline", readLineNumbers: true }), { immutable: true }),
		).toEqual({ hashLines: false, lineNumbers: true });
	});
});

describe("resolveFileDisplayMode — raw reads", () => {
	it("suppresses both hashlines and line numbers for a raw read", () => {
		expect(resolveFileDisplayMode(session({ editMode: "hashline" }), { raw: true })).toEqual({
			hashLines: false,
			lineNumbers: false,
		});
	});

	it("suppresses line numbers on a raw read even when readLineNumbers is on", () => {
		expect(resolveFileDisplayMode(session({ editMode: "replace", readLineNumbers: true }), { raw: true })).toEqual({
			hashLines: false,
			lineNumbers: false,
		});
	});
});

describe("resolveFileDisplayMode — non-hashline modes", () => {
	it("never emits hashlines but follows readLineNumbers when true", () => {
		expect(resolveFileDisplayMode(session({ editMode: "replace", readLineNumbers: true }))).toEqual({
			hashLines: false,
			lineNumbers: true,
		});
	});

	it("emits neither when readLineNumbers is off in a non-hashline mode", () => {
		expect(resolveFileDisplayMode(session({ editMode: "replace", readLineNumbers: false }))).toEqual({
			hashLines: false,
			lineNumbers: false,
		});
	});
});
