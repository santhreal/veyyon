import { describe, expect, it } from "bun:test";
import * as prompt from "@veyyon/utils/prompt";

const FULL = { renderPhase: "pre-render", replaceAsciiSymbols: true, normalizeRfc2119: true } as const;

describe("format: ascii symbol replacement", () => {
	it("replaces all seven symbols in one line", () => {
		expect(prompt.format("a -> b <- c <-> d != e <= f >= g ... h", FULL)).toBe("a → b ← c ↔ d ≠ e ≤ f ≥ g … h");
	});

	it("prioritizes <-> over -> and <- on overlapping input", () => {
		// `<=->` must resolve as `<=` + `->`, and `<->` must win over its halves.
		expect(prompt.format("<=-> <-> ->= <-- -->x", FULL)).toBe("≤→ ↔ →= ←- -→x");
	});

	it("consumes ellipsis runs greedily in threes", () => {
		expect(prompt.format("....... ..", FULL)).toBe("……. ..");
		expect(prompt.format("......", FULL)).toBe("……");
		expect(prompt.format("....", FULL)).toBe("….");
	});

	it("skips replacements inside html comments, including multi-line state", () => {
		expect(prompt.format("<!-- a -> b --> c -> d", FULL)).toBe("<!-- a -> b --> c → d");
		expect(prompt.format("<!--\nA -> B\n-->\nC -> D", FULL)).toBe("<!--\nA -> B\n-->\nC → D");
	});

	it("replaces symbols on a line containing --> but no opener", () => {
		expect(prompt.format("x --> y != z", FULL)).toBe("x -→ y ≠ z");
	});

	it("leaves code fences untouched", () => {
		const input = "```\na -> b\n```";
		expect(prompt.format(input, FULL)).toBe(input);
	});
});

describe("format: rfc 2119 normalization", () => {
	it("strips bold and aliases MUST NOT / SHOULD NOT outside inline code", () => {
		expect(prompt.format("You **MUST** act. You **MUST NOT** stall. SHOULD NOT applies.", FULL)).toBe(
			"You MUST act. You NEVER stall. AVOID applies.",
		);
	});

	it("preserves keywords inside inline code spans", () => {
		expect(prompt.format("alias `MUST NOT` means MUST NOT", FULL)).toBe("alias `MUST NOT` means NEVER");
	});

	it("leaves non-keyword bold alone", () => {
		expect(prompt.format("**bold** stays **bold**", FULL)).toBe("**bold** stays **bold**");
	});
});

describe("format: structure", () => {
	it("compacts table rows and separators, preserving indent and alignment", () => {
		expect(prompt.format("| a | b |\n|:--- | --:|\n| c | d |")).toBe("|a|b|\n|:---|---:|\n|c|d|");
		expect(prompt.format("  | a | b |")).toBe("  |a|b|");
	});

	it("collapses runs of 2+ blank lines and trims boundary blanks", () => {
		expect(prompt.format("\n\na\n\n\nb\n \n\t\nc\n\n")).toBe("a\nb\nc");
		expect(prompt.format("a\n\nb")).toBe("a\n\nb");
	});

	it("drops a single blank line before a closing xml tag", () => {
		expect(prompt.format("<tag>\nbody\n\n</tag>")).toBe("<tag>\nbody\n</tag>");
	});

	it("does not treat self-closing or attribute-laden non-tags as block tags", () => {
		// `<a b> c>` is not an opening tag (inner `>`); blank before `</a>` still pops.
		expect(prompt.format('<a attr="x">\nbody\n\n</a>')).toBe('<a attr="x">\nbody\n</a>');
		expect(prompt.format("<self/>\nx")).toBe("<self/>\nx");
	});

	/**
	 * The blank-pop before a closing tag is deliberately NOT nesting-aware: it
	 * fires for any top-of-line `</name>` at any depth, and even for an unbalanced
	 * closing tag that was never opened. These goldens lock that behavior after
	 * removing the dead `topLevelTags` bookkeeping (write-only state that tracked
	 * open tags but never influenced output); the outputs are byte-for-byte what
	 * the pre-removal implementation produced. A future nesting-aware change must
	 * update these expectations on purpose, not drift into them.
	 */
	it("pops the blank before every closing tag regardless of nesting depth", () => {
		expect(prompt.format("<outer>\n<inner>\nbody\n\n</inner>\n\n</outer>")).toBe(
			"<outer>\n<inner>\nbody\n</inner>\n</outer>",
		);
		expect(prompt.format("<a>\n<b>\n<c>\ntext\n\n</c>\n</b>\n</a>")).toBe("<a>\n<b>\n<c>\ntext\n</c>\n</b>\n</a>");
	});

	it("pops the blank before an unbalanced closing tag that was never opened", () => {
		expect(prompt.format("body\n\n</orphan>")).toBe("body\n</orphan>");
	});

	it("leaves a repeated same-name block and its inner blank handling intact", () => {
		expect(prompt.format("<t>\none\n</t>\n<t>\ntwo\n\n</t>")).toBe("<t>\none\n</t>\n<t>\ntwo\n</t>");
	});

	it("keeps blank handling inside code fences verbatim", () => {
		const input = "```\na\n\n\n\nb\n```";
		expect(prompt.format(input)).toBe(input);
	});

	it("pops blanks before handlebars block closers only in pre-render", () => {
		expect(prompt.format("{{#if x}}\nbody\n\n{{/if}}", { renderPhase: "pre-render" })).toBe(
			"{{#if x}}\nbody\n{{/if}}",
		);
		expect(prompt.format("body\n\n{{/if}}", { renderPhase: "post-render" })).toBe("body\n\n{{/if}}");
	});
});

describe("compile cache", () => {
	it("returns the identical compiled function for repeat compiles of the same template", () => {
		const template = "Hello {{name}} {{#if x}}yes{{/if}}";
		expect(prompt.compile(template)).toBe(prompt.compile(template));
	});

	it("renders templates with 3+ closing braces unambiguously", () => {
		expect(prompt.render("{{#if a}}{ {{b}}}{{/if}}", { a: true, b: "v" })).toBe("{ v}");
	});
});

describe("helpers: join", () => {
	it("unescapes \\n and \\t in the separator (Handlebars string literals carry no escapes)", () => {
		// Regression: `{{join files "\n"}}` used to emit the literal two-char `\n`
		// between entries (visible in compaction <read-files> lists).
		expect(prompt.render('{{join files "\\n"}}', { files: ["a.ts", "b.ts"] })).toBe("a.ts\nb.ts");
		expect(prompt.render('{{join files "\\t"}}', { files: ["a.ts", "b.ts"] })).toBe("a.ts\tb.ts");
	});

	it("defaults to comma-space and tolerates non-arrays", () => {
		expect(prompt.render("{{join files}}", { files: ["a", "b"] })).toBe("a, b");
		expect(prompt.render("{{join files}}", { files: "not-an-array" })).toBe("");
	});
});

/**
 * Raw helper output, BEFORE the `format` post-pass. `compile(t)(c)` returns the
 * plain Handlebars render so a helper's exact string is asserted in isolation
 * (the separate `format: *` suites above cover what post-render does to it).
 * These helpers gate real template content across all three system prompts; an
 * off-by-one or a swapped truthy check renders the wrong branch with no other
 * signal, so each is pinned positive, negative, and at its boundaries.
 */
const raw = (template: string, context: Record<string, unknown> = {}): string => prompt.compile(template)(context);

describe("helpers: arg", () => {
	it("is 1-based: {{arg 1}} is the first argument", () => {
		expect(raw("{{arg 1}}", { args: ["first", "second"] })).toBe("first");
		expect(raw("{{arg 2}}", { args: ["first", "second"] })).toBe("second");
	});

	it("accepts a string index (parseInt) identically to a numeric one", () => {
		expect(raw('{{arg "2"}}', { args: ["first", "second"] })).toBe("second");
	});

	it("returns empty for index 0, out-of-range, non-numeric, or missing args", () => {
		expect(raw("{{arg 0}}", { args: ["a"] })).toBe("");
		expect(raw("{{arg 5}}", { args: ["a"] })).toBe("");
		expect(raw('{{arg "x"}}', { args: ["a"] })).toBe("");
		expect(raw("{{arg 1}}", {})).toBe("");
	});
});

describe("helpers: list", () => {
	it("applies prefix, suffix, and default newline join over the array", () => {
		expect(raw("{{#list items prefix=\"- \"}}{{this}}{{/list}}", { items: ["a", "b"] })).toBe("- a\n- b");
		expect(raw("{{#list items suffix=\";\"}}{{this}}{{/list}}", { items: ["a", "b"] })).toBe("a;\nb;");
	});

	it("unescapes \\n and \\t in the join separator", () => {
		expect(raw('{{#list items join=", "}}{{this}}{{/list}}', { items: ["a", "b", "c"] })).toBe("a, b, c");
		expect(raw('{{#list items join="\\t"}}{{this}}{{/list}}', { items: ["a", "b"] })).toBe("a\tb");
	});

	it("renders empty string for a non-array or empty array", () => {
		expect(raw("{{#list items}}{{this}}{{/list}}", { items: [] })).toBe("");
		expect(raw("{{#list items}}{{this}}{{/list}}", { items: "nope" })).toBe("");
	});
});

describe("helpers: default", () => {
	it("returns the value when truthy, otherwise the fallback", () => {
		expect(raw('{{default name "anon"}}', { name: "real" })).toBe("real");
		expect(raw('{{default name "anon"}}', { name: "" })).toBe("anon");
		expect(raw('{{default name "anon"}}', {})).toBe("anon");
	});

	it("treats falsy scalars (0, false) as absent, but a non-empty string as present", () => {
		expect(raw('{{default n "fb"}}', { n: 0 })).toBe("fb");
		expect(raw('{{default n "fb"}}', { n: false })).toBe("fb");
		expect(raw('{{default n "fb"}}', { n: "0" })).toBe("0");
	});
});

describe("helpers: pluralize", () => {
	it("uses the singular only for exactly 1", () => {
		expect(raw('{{pluralize n "item" "items"}}', { n: 1 })).toBe("1 item");
		expect(raw('{{pluralize n "item" "items"}}', { n: 0 })).toBe("0 items");
		expect(raw('{{pluralize n "item" "items"}}', { n: 2 })).toBe("2 items");
		expect(raw('{{pluralize n "item" "items"}}', { n: -1 })).toBe("-1 items");
	});
});

describe("helpers: when", () => {
	const T = (op: string) => `{{#when a "${op}" b}}Y{{else}}N{{/when}}`;
	it("evaluates each comparison operator", () => {
		expect(raw(T("=="), { a: 2, b: 2 })).toBe("Y");
		expect(raw(T("==="), { a: 2, b: 2 })).toBe("Y");
		expect(raw(T("==="), { a: 2, b: "2" })).toBe("N");
		expect(raw(T("!="), { a: 2, b: 3 })).toBe("Y");
		expect(raw(T("!=="), { a: 2, b: "2" })).toBe("Y");
		expect(raw(T(">"), { a: 3, b: 2 })).toBe("Y");
		expect(raw(T("<"), { a: 1, b: 2 })).toBe("Y");
		expect(raw(T(">="), { a: 2, b: 2 })).toBe("Y");
		expect(raw(T("<="), { a: 2, b: 2 })).toBe("Y");
	});

	it("renders the inverse branch for an unknown operator", () => {
		expect(raw(T("<=>"), { a: 1, b: 1 })).toBe("N");
	});

	it("renders the inverse branch when a numeric comparison operand is missing", () => {
		expect(raw(T(">"), { b: 0 })).toBe("N");
	});
});

describe("helpers: ifAny / ifAll", () => {
	it("ifAny is true when at least one argument is truthy", () => {
		expect(raw("{{#ifAny a b c}}Y{{else}}N{{/ifAny}}", { a: 0, b: "", c: "x" })).toBe("Y");
		expect(raw("{{#ifAny a b c}}Y{{else}}N{{/ifAny}}", { a: 0, b: "", c: false })).toBe("N");
	});

	it("ifAll is true only when every argument is truthy", () => {
		expect(raw("{{#ifAll a b}}Y{{else}}N{{/ifAll}}", { a: "x", b: 1 })).toBe("Y");
		expect(raw("{{#ifAll a b}}Y{{else}}N{{/ifAll}}", { a: "x", b: 0 })).toBe("N");
	});
});

describe("helpers: has vs includes (object-key asymmetry is intentional)", () => {
	it("has matches array membership, Set/Map keys, and plain-object keys", () => {
		expect(raw("{{#has c i}}Y{{else}}N{{/has}}", { c: ["a", "b"], i: "b" })).toBe("Y");
		expect(raw("{{#has c i}}Y{{else}}N{{/has}}", { c: new Set(["a"]), i: "a" })).toBe("Y");
		expect(raw("{{#has c i}}Y{{else}}N{{/has}}", { c: new Map([["k", 1]]), i: "k" })).toBe("Y");
		expect(raw("{{#has c i}}Y{{else}}N{{/has}}", { c: { k: 1 }, i: "k" })).toBe("Y");
		expect(raw("{{#has c i}}Y{{else}}N{{/has}}", { c: ["a"], i: "z" })).toBe("N");
	});

	it("includes matches array/Set/Map but NOT plain-object keys (unlike has)", () => {
		expect(raw("{{#if (includes c i)}}Y{{else}}N{{/if}}", { c: ["a", "b"], i: "a" })).toBe("Y");
		expect(raw("{{#if (includes c i)}}Y{{else}}N{{/if}}", { c: new Set(["a"]), i: "a" })).toBe("Y");
		// The documented distinction: `includes` is collection-membership only, so
		// an object key returns false where `has` would return true. Pinned so the
		// two helpers cannot silently converge or diverge by accident.
		expect(raw("{{#if (includes c i)}}Y{{else}}N{{/if}}", { c: { k: 1 }, i: "k" })).toBe("N");
	});
});

describe("helpers: len / add / sub / not", () => {
	it("len returns array and string length, and 0 for anything else", () => {
		expect(raw("{{len v}}", { v: ["a", "b", "c"] })).toBe("3");
		expect(raw("{{len v}}", { v: "abcd" })).toBe("4");
		expect(raw("{{len v}}", { v: new Set(["a", "b"]) })).toBe("0");
		expect(raw("{{len v}}", { v: 42 })).toBe("0");
	});

	it("add and sub coerce missing operands to 0", () => {
		expect(raw("{{add 2 3}}", {})).toBe("5");
		expect(raw("{{sub 5 2}}", {})).toBe("3");
		expect(raw("{{add a b}}", { a: 4 })).toBe("4");
		expect(raw("{{sub a b}}", { b: 3 })).toBe("-3");
	});

	it("not inverts truthiness for use in subexpressions", () => {
		expect(raw("{{#if (not v)}}Y{{else}}N{{/if}}", { v: 0 })).toBe("Y");
		expect(raw("{{#if (not v)}}Y{{else}}N{{/if}}", { v: "x" })).toBe("N");
	});
});

describe("helpers: escapeXml / jsonStringify", () => {
	it("escapeXml escapes & < > \" and escapes & first so entities are not double-escaped", () => {
		expect(raw("{{escapeXml v}}", { v: '<a href="x&y">' })).toBe("&lt;a href=&quot;x&amp;y&quot;&gt;");
		expect(raw("{{escapeXml v}}", { v: null })).toBe("");
	});

	it("jsonStringify emits a JSON representation of the value", () => {
		expect(raw("{{jsonStringify v}}", { v: { a: 1, b: ["x"] } })).toBe('{"a":1,"b":["x"]}');
	});
});

describe("helpers: block wrappers (xml, codeblock, table)", () => {
	it("xml wraps non-empty content and collapses to empty for blank content", () => {
		expect(raw('{{#xml "note"}}body{{/xml}}', {})).toBe("<note>\nbody\n</note>");
		expect(raw('{{#xml "note"}}   {{/xml}}', {})).toBe("");
	});

	it("codeblock fences trimmed content with an optional language", () => {
		expect(raw('{{#codeblock lang="ts"}}  const x = 1;  {{/codeblock}}', {})).toBe("```ts\nconst x = 1;\n```");
		expect(raw("{{#codeblock}}plain{{/codeblock}}", {})).toBe("```\nplain\n```");
	});

	it("table builds a header row, separator, and one row per item", () => {
		const out = raw('{{#table rows headers="A|B"}}{{x}}|{{y}}{{/table}}', { rows: [{ x: 1, y: 2 }, { x: 3, y: 4 }] });
		expect(out).toBe("| A | B |\n| --- | --- |\n| 1|2 |\n| 3|4 |");
	});

	it("table returns empty for a non-array or empty context", () => {
		expect(raw('{{#table rows headers="A"}}{{x}}{{/table}}', { rows: [] })).toBe("");
	});
});
