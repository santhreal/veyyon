/**
 * Text that `format` keeps as it is, apart from blank lines at its end, comes back as a cut of the
 * input rather than a second copy of it.
 *
 * WHY THIS SUITE EXISTS. `format` split every text into lines and joined them back whether or not it
 * rewrote any. A tool description or prompt with no mustache renders as `format(template)`, and the
 * join built a new string holding all of the template but its final newline. The module holds the
 * template and the interned render result is held by every tool and prompt section that renders
 * it, so each such prompt sat on the heap twice.
 *
 * THE CLASS, NOT THE INCIDENT. Sharing is decided where every kept line passes through: a line kept
 * as it stands, right after the line kept before it, extends one slice of the input, and anything
 * else starts a new piece of a join. The sweep takes every reason `format` rewrites, skips or moves
 * a line, puts it in text that is otherwise unchanged, and requires the rewritten output, so a reason
 * that fails to end the slice returns the input instead and goes red. The heap probe formats large
 * distinct texts of each shape that needs no rewrite and requires the heap snapshot to hold each text
 * once; a rewritten text is the control that must be held twice, which proves the probe sees a copy
 * when one is made.
 *
 * WHAT IT DOES NOT CATCH. A rewrite reason added to `format` later is not enumerated here; it is
 * caught only when it keeps its line as a slice of the input. The probe measures `format`, not
 * `render`: `render` interns the result, and the heap snapshot reports no interned string as a string
 * node, so the count cannot tell a shared result from a copied one there. `renderSequence`
 * concatenates its templates, so its output is one new string whichever way `format` returns it.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { format, type PromptFormatOptions } from "@veyyon/utils/prompt";

const FULL: PromptFormatOptions = { renderPhase: "pre-render", replaceAsciiSymbols: true, normalizeRfc2119: true };

/** Every reason `format` changes a line, in text where nothing else changes. */
const REWRITES: Record<string, { input: string; output: string; options?: PromptFormatOptions }> = {
	"trailing whitespace on a line": { input: "a  \nb", output: "a\nb" },
	"trailing whitespace on a fence line": { input: "```  \nx\n```", output: "```\nx\n```" },
	"trailing whitespace on a code line": { input: "```\nx \t\n```", output: "```\nx\n```" },
	"a carriage return": { input: "a\r\nb", output: "a\nb" },
	"a leading blank line": { input: "\na\nb", output: "a\nb" },
	"a run of blank lines": { input: "a\n\n\nb", output: "a\nb" },
	"a whitespace-only line": { input: "a\n \t\nb", output: "a\n\nb" },
	"a blank line before a closing tag": { input: "<t>\nx\n\n</t>", output: "<t>\nx\n</t>" },
	"a blank line before a block closer": {
		input: "{{#if x}}\nbody\n\n{{/if}}",
		output: "{{#if x}}\nbody\n{{/if}}",
		options: { renderPhase: "pre-render" },
	},
	"a table row": { input: "a\n| a | b |", output: "a\n|a|b|" },
	"a table separator": { input: "a\n|:--- | --:|", output: "a\n|:---|---:|" },
	"an ascii symbol": { input: "a\nx -> y", output: "a\nx → y", options: FULL },
	"an rfc 2119 keyword": { input: "a\nYou **MUST** act.", output: "a\nYou MUST act.", options: FULL },
};

/** Text `format` keeps as it is, paired with what it returns. */
const UNCHANGED: Record<string, { input: string; output: string }> = {
	"text with no final newline": { input: "a\n\nb", output: "a\n\nb" },
	"text ending in a newline": { input: "a\nb\n", output: "a\nb" },
	"text ending in blank and whitespace-only lines": { input: "a\nb\n\n \t\n\n", output: "a\nb" },
	"code with blank lines": { input: "```\na\n\n\nb\n```\n", output: "```\na\n\n\nb\n```" },
	"nothing but blank lines": { input: "\n \n\t\n", output: "" },
};

describe("format of text it rewrites", () => {
	for (const [reason, { input, output, options }] of Object.entries(REWRITES)) {
		it(`rewrites ${reason}`, () => {
			expect(format(input, options)).toBe(output);
		});
	}
});

describe("format of text it keeps", () => {
	for (const [shape, { input, output }] of Object.entries(UNCHANGED)) {
		it(`returns ${shape} cut after its last kept line`, () => {
			expect(format(input, FULL)).toBe(output);
		});
	}
});

/**
 * Formats eight large distinct texts of each shape in a fresh process, holds every input and every
 * result, collects, and counts per shape the heap strings that hold a whole text: a string node that
 * starts with the shape's marker and whose self size covers the text. A cut of an input shares its
 * buffer and has no such node of its own; a joined result does. Each result is also checked against
 * the input with its trailing blank lines dropped, or its one rewrite applied.
 */
const HEAP_PROBE = `
const { format } = await import("@veyyon/utils/prompt");
const { detachedString } = await import("@veyyon/utils/strings");
const N = 8;
const LENGTH = 64 * 4096;
const body = (marker, k) =>
	marker + k + Array.from({ length: 64 }, (_, j) => String.fromCharCode(65 + ((k + j) % 26)).repeat(4096)).join("\\n");
const SHAPES = {
	"ending in a newline": ["<n>", t => t + "\\n"],
	"with no final newline": ["<f>", t => t],
	"ending in blank and whitespace-only lines": ["<w>", t => t + "\\n\\n \\t\\n\\n"],
	"rewritten": ["<r>", t => t + "  \\nend"],
};
const report = {};
const held = [];
for (const [shape, [marker, wrap]] of Object.entries(SHAPES)) {
	const texts = Array.from({ length: N }, (_, k) => body(marker, k));
	const inputs = texts.map(t => detachedString(wrap(t)));
	const outputs = inputs.map(input => format(input));
	const expected = texts.map(t => (shape === "rewritten" ? t + "\\nend" : t));
	held.push(inputs, outputs);
	report[shape] = { marker, correct: outputs.every((out, k) => out === expected[k]), copies: 0 };
}
globalThis.held = held;
Bun.gc(true);
const snap = JSON.parse(Bun.generateHeapSnapshot("v8"));
const fields = snap.snapshot.meta.node_fields;
const stride = fields.length;
const typeAt = fields.indexOf("type");
const nameAt = fields.indexOf("name");
const sizeAt = fields.indexOf("self_size");
const stringType = snap.snapshot.meta.node_types[0].indexOf("string");
for (let i = 0; i < snap.nodes.length; i += stride) {
	if (snap.nodes[i + typeAt] !== stringType || snap.nodes[i + sizeAt] < LENGTH) continue;
	const value = snap.strings[snap.nodes[i + nameAt]];
	for (const entry of Object.values(report)) if (value.startsWith(entry.marker)) entry.copies++;
}
process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(report).map(([shape, { correct, copies }]) => [shape, { correct, copies }]))));
`;

describe("a prompt with nothing to rewrite formats without a copy", () => {
	it("holds each kept text once and each rewritten text twice", () => {
		const probe = spawnSync(process.execPath, ["-e", HEAP_PROBE], {
			cwd: path.join(import.meta.dirname, ".."),
			encoding: "utf8",
		});
		expect(probe.stderr).toBe("");
		expect(JSON.parse(probe.stdout)).toEqual({
			"ending in a newline": { correct: true, copies: 8 },
			"with no final newline": { correct: true, copies: 8 },
			"ending in blank and whitespace-only lines": { correct: true, copies: 8 },
			rewritten: { correct: true, copies: 16 },
		});
	});
});
