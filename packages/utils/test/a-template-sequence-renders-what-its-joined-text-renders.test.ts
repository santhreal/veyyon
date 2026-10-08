/**
 * WHY THIS SUITE EXISTS.
 *
 * `prompt.renderSequence(templates, context)` promises the bytes `prompt.render(templates.join(""),
 * context)` renders. When every template holding a mustache has a build-time compilation, it
 * renders each on its own and joins the results, so the joined text is never parsed; the system
 * prompt relies on that to start a binary session without the Handlebars compiler.
 *
 * THE CLASS. Rendering one by one where a boundary changes the bytes: a template that does not end
 * with a newline, so the next one's standalone lines read differently; the `~` whitespace control
 * on either side, which strips across a boundary; a template no build compiled, which may be a
 * fragment of a block that opens in one template and closes in another. Each of those must render
 * joined. And the converse: a sequence that is safe must not parse its joined text, including one
 * with empty templates, plain text and a last template without a newline. Every pair of the whole
 * templates below is compared both ways, under two contexts, with the separator between them and
 * without.
 *
 * HOW. The suite registers each whole template's build-time compilation as the binary's `.md`
 * modules do, from `precompileTemplate`, and records every text the Handlebars parser receives. A
 * sequence that must render one by one renders behind a compiled first template no other render
 * used, and before its joined render is taken, so a sequence that falls back to its joined text
 * parses it rather than reusing the compilation an earlier render cached.
 *
 * WHAT IT DOES NOT CATCH. A Handlebars construct none of the templates below uses at a boundary (a
 * partial, a decorator, a raw block). The production sequences, the statement templates of the
 * default system prompt, are compared against their joined render by
 * `packages/coding-agent/test/a-session-of-precompiled-prompts-evaluates-no-handlebars-compiler.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as prompt from "@veyyon/utils/prompt";
import { registerPrecompiledTemplate } from "@veyyon/utils/prompt-precompiled";
import Handlebars from "handlebars";

/** Whole templates, each compiled on its own; every one but the last ends with a newline. */
const WHOLE: readonly string[] = [
	"seq plain text, no mustache\n",
	"seq inline {{name}} mid-line\n",
	"{{#if flag}}\nseq standalone block opens the template\n{{/if}}\n",
	"seq a block closes the template\n{{#if flag}}\ninside\n{{/if}}\n",
	"  {{#if flag}}\n  seq indented standalone block\n  {{/if}}\n",
	"{{#each items}}\n- seq item {{this}}\n{{/each}}\n",
	"{{! a standalone comment }}\nseq after a comment\n",
	"seq else arm\n{{#if flag}}\nyes\n{{else}}\nno\n{{/if}}\n",
	"seq trailing spaces the format pass trims   \n\n\n\n\nseq after blank lines\n",
	"\n",
];

/** A last template, which need not end with a newline. */
const LAST = "seq last template {{name}} has no newline";

/** Compiled templates that must still render joined, because a boundary would change their bytes. */
const UNSAFE: Readonly<Record<string, readonly string[]>> = {
	"a template before the last that does not end with a newline": [
		"seq no newline {{name}}",
		"{{#if flag}}\nseq after it\n{{/if}}\n",
	],
	"a `{{~` that strips the newline before it": ["seq before a tilde\n", "{{~name}} seq tail\n"],
	"a `~}}` that strips the indentation after it": ["seq tilde {{name~}}\n", "  seq indented tail\n"],
};

/** Templates no build compiled: a block that opens in one and closes in another. */
const FRAGMENTS: readonly string[] = ["{{#if flag}}\n", "seq inside a split block\n", "{{/if}}\n"];

const CONTEXTS: readonly prompt.TemplateContext[] = [
	{ flag: true, name: "NAME", items: ["x", "y"] },
	{ flag: false, name: "NAME", items: [] },
];

/** Every text the Handlebars parser received since the last {@link takeParsed}. */
let parsed: string[] = [];
const parser = (Handlebars as unknown as { Parser: { parse(input: string): unknown } }).Parser;
const parse = parser.parse;

function takeParsed(): string[] {
	const taken = parsed;
	parsed = [];
	return taken;
}

/** `prompt.render` of the joined text, and the texts that render parsed. */
function joinedRender(templates: readonly string[], context: prompt.TemplateContext): string {
	const rendered = prompt.render(templates.join(""), context);
	takeParsed();
	return rendered;
}

/** Register `template`'s build-time compilation, as a binary's `.md` module does. */
function registerCompiled(template: string): void {
	const { spec, variables } = prompt.precompileTemplate(template);
	const revived = new Function(`return (${spec});`)() as object;
	registerPrecompiledTemplate(
		template,
		() => revived,
		() => variables,
	);
}

let freshCount = 0;

/**
 * `prompt.renderSequence` of `templates` behind a compiled first template no other render used, the
 * texts that render parsed, and the joined render it must equal. The sequence renders before its
 * joined text, which is new to the process, so a fallback to the joined text parses it.
 */
function renderFresh(
	templates: readonly string[],
	context: prompt.TemplateContext,
): { rendered: string; parsed: string[]; expected: string } {
	const first = `seq fresh sequence ${++freshCount} {{name}}\n`;
	registerCompiled(first);
	takeParsed();
	const sequence = [first, ...templates];
	const rendered = prompt.renderSequence(sequence, context);
	const parsed = takeParsed();
	return { rendered, parsed, expected: joinedRender(sequence, context) };
}

beforeAll(() => {
	parser.parse = function (this: unknown, input: string): unknown {
		parsed.push(input);
		return parse.call(this, input);
	};
	for (const template of [...WHOLE, LAST, ...Object.values(UNSAFE).flat()]) {
		if (template.includes("{{")) registerCompiled(template);
	}
	takeParsed();
});

afterAll(() => {
	parser.parse = parse;
});

describe("a sequence of compiled templates", () => {
	test("renders every pair as the joined text renders, and parses nothing", () => {
		const cases: string[][] = [];
		for (const first of WHOLE) {
			for (const second of [...WHOLE, LAST]) {
				cases.push([first, second], [first, "\n", second]);
			}
		}
		for (const templates of cases) {
			for (const context of CONTEXTS) {
				const { rendered, parsed, expected } = renderFresh(templates, context);
				expect({ templates, rendered, parsed }).toEqual({ templates, rendered: expected, parsed: [] });
			}
		}
	});

	test("renders one by one around empty templates, anywhere in the sequence", () => {
		const cases = [
			["", WHOLE[1]!, "", WHOLE[2]!, ""],
			[WHOLE[0]!, LAST, "", ""],
		];
		for (const templates of cases) {
			const { rendered, parsed, expected } = renderFresh(templates, CONTEXTS[0]!);
			expect({ templates, rendered, parsed }).toEqual({ templates, rendered: expected, parsed: [] });
		}
	});

	test("fails on a hole as the joined text fails, and renders the hole when told to", () => {
		const templates = [WHOLE[0]!, WHOLE[1]!, LAST];
		const context = { flag: true, items: [] };
		expect(() => prompt.render(templates.join(""), context)).toThrow(prompt.MissingTemplateVariableError);
		expect(() => prompt.renderSequence(templates, context)).toThrow(prompt.MissingTemplateVariableError);
		takeParsed();
		// The sequence renders before its joined text, so a fallback to the joined text parses it.
		const rendered = prompt.renderSequence(templates, context, { allowMissing: true });
		expect(takeParsed()).toEqual([]);
		expect(rendered).toBe(prompt.render(templates.join(""), context, { allowMissing: true }));
	});
});

describe("a sequence that renders joined", () => {
	for (const [name, templates] of Object.entries(UNSAFE)) {
		test(`holds ${name}`, () => {
			let differs = false;
			for (const context of CONTEXTS) {
				const expected = joinedRender(templates, context);
				expect(prompt.renderSequence(templates, context)).toBe(expected);
				// Each template's own render, joined and formatted once: the bytes a one-by-one render would give.
				const pieces = templates.map(template => prompt.compile(template)(context)).join("");
				differs ||= prompt.format(pieces, { renderPhase: "post-render" }) !== expected;
			}
			// Some context tells the two apart, which is why this sequence must not render one by one.
			expect(differs).toBe(true);
		});
	}

	test("holds a template no build compiled, which may be part of a block split across templates", () => {
		for (const context of CONTEXTS) {
			const expected = joinedRender(FRAGMENTS, context);
			expect(prompt.renderSequence(FRAGMENTS, context)).toBe(expected);
		}
	});
});
