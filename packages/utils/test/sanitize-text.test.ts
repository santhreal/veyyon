import { describe, expect, it } from "bun:test";
import { escapeXmlAttribute, escapeXmlText, sanitizeText } from "@veyyon/utils/sanitize-text";

describe("sanitizeText", () => {
	it("strips ANSI CSI and removes C0/C1 control chars while keeping tab + LF", () => {
		const input = "\x1b[31mred\x1b[0m\ra\u0000b\tline\ncarriage\r\u0001\u0085";
		expect(sanitizeText(input)).toBe("redab\tline\ncarriage");
	});

	it("drops lone surrogates and preserves valid surrogate pairs", () => {
		expect(sanitizeText(`a\ud800b\udc00c`)).toBe("abc");
		const validPair = "a\u{1f600}b";
		expect(sanitizeText(validPair)).toBe(validPair);
	});

	it("drops replacement characters on malformed input", () => {
		expect(sanitizeText("a\ud800�b")).toBe("ab");
	});

	it("preserves replacement characters on well-formed input", () => {
		expect(sanitizeText("a�b")).toBe("a�b");
	});

	it("preserves valid surrogate pairs while stripping controls", () => {
		const validPair = "\u{1f600}";
		expect(sanitizeText(`a${validPair}\u0000b`)).toBe(`a${validPair}b`);
	});

	it("strips OSC sequences terminated by BEL", () => {
		expect(sanitizeText("\x1b]0;title\x07hello")).toBe("hello");
	});

	it("strips OSC sequences terminated by ST (ESC \\)", () => {
		expect(sanitizeText("\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\!")).toBe("link!");
	});

	it("returns the original string instance when no changes are needed", () => {
		const clean = "plain ascii\twith\ttabs\nand newlines";
		expect(sanitizeText(clean)).toBe(clean);
	});

	it("strips DCS sequences terminated by ST", () => {
		expect(sanitizeText("before\x1bPpayload\x1b\\after")).toBe("beforeafter");
	});

	it("handles single-byte ESC finals (e.g. ESC c reset)", () => {
		expect(sanitizeText("a\x1bcb")).toBe("ab");
	});

	it("strips DEL and normalizes lone CR", () => {
		expect(sanitizeText("a\x7fb\rc")).toBe("abc");
	});
});

/**
 * Behavior lock for `escapeXmlText`, the canonical XML-text escaper in
 * `@veyyon/utils`. It escapes exactly the three characters that are unsafe in
 * XML/HTML *element text* — `&`, `<`, `>` — to `&amp;`, `&lt;`, `&gt;`, and
 * leaves everything else (including `"` and `'`, which only matter inside
 * attributes) untouched. The implementation is a single pass with a fast path
 * that returns the input UNCHANGED (same reference, no allocation) when nothing
 * needs escaping.
 *
 * This suite exists to make a duplicate safe to delete. `@veyyon/ai`'s dialect
 * layer (`dialect/rendering.ts`) shipped its OWN `escapeXmlText`, a naive
 * `.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")` — a
 * second implementation of the same contract (ONE-PLACE violation, and a 3-pass
 * / 3-allocation version of a job the utils owner does in one pass, Law 7).
 * Before folding that copy into a re-export of this owner, the two must be
 * proven to produce identical output on every input, so the migration cannot
 * change a single rendered transcript. `naiveReference` below is a byte-for-byte
 * copy of the ai implementation being removed, and the differential test runs it
 * against `escapeXmlText` over an exhaustive short-string corpus plus crafted
 * adversarial cases.
 *
 * The order of escaping matters and is asserted directly: `&` is escaped as a
 * literal, and the `&` introduced *by* escaping `<`/`>` (inside `&lt;`/`&gt;`)
 * must NOT be re-escaped, or a single `<` would become `&amp;lt;`. Both the
 * single-pass owner and the ordered triple-replaceAll get this right because
 * each source character is transformed exactly once; the differential pins that
 * they agree.
 */

/** Byte-for-byte the implementation removed from `ai/dialect/rendering.ts`. */
function naiveReference(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

describe("escapeXmlText — the three escaped characters", () => {
	it("escapes an ampersand to &amp;", () => {
		expect(escapeXmlText("&")).toBe("&amp;");
	});

	it("escapes a less-than to &lt;", () => {
		expect(escapeXmlText("<")).toBe("&lt;");
	});

	it("escapes a greater-than to &gt;", () => {
		expect(escapeXmlText(">")).toBe("&gt;");
	});

	it("escapes all three together in place, preserving surrounding text", () => {
		expect(escapeXmlText("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
	});

	it("escapes a real tag-like span into inert text", () => {
		expect(escapeXmlText("<tool_name>x & y</tool_name>")).toBe("&lt;tool_name&gt;x &amp; y&lt;/tool_name&gt;");
	});

	it("escapes consecutive escapables independently, without merging", () => {
		expect(escapeXmlText("&&")).toBe("&amp;&amp;");
		expect(escapeXmlText("<<")).toBe("&lt;&lt;");
		expect(escapeXmlText("<&>")).toBe("&lt;&amp;&gt;");
	});
});

describe("escapeXmlText — the ampersand ordering trap", () => {
	it("does NOT double-escape the ampersand that escaping < / > introduces", () => {
		// The single `<` must become `&lt;`, never `&amp;lt;`. This is the exact bug
		// a wrong escape order (or a second pass over the output) would create.
		expect(escapeXmlText("<")).toBe("&lt;");
		expect(escapeXmlText("<x>")).toBe("&lt;x&gt;");
	});

	it("escapes an already-escaped entity's leading ampersand (escaping is not idempotent, by contract)", () => {
		// `&amp;` contains a literal `&`, which is data and gets escaped again. This
		// is correct for text escaping: the function has no notion of "already an
		// entity". Locked so nobody "fixes" it into a lossy idempotent version.
		expect(escapeXmlText("&amp;")).toBe("&amp;amp;");
		expect(escapeXmlText("&lt;")).toBe("&amp;lt;");
	});
});

describe("escapeXmlText — characters it must leave alone", () => {
	it("does not escape double or single quotes (those are attribute-only concerns)", () => {
		expect(escapeXmlText(`"'`)).toBe(`"'`);
		expect(escapeXmlText(`say "hi" it's fine`)).toBe(`say "hi" it's fine`);
	});

	it("passes through whitespace, slashes, unicode, and emoji untouched", () => {
		expect(escapeXmlText("a\n\tb / c")).toBe("a\n\tb / c");
		expect(escapeXmlText("café — 日本語 — 🚀")).toBe("café — 日本語 — 🚀");
	});

	it("only ever expands the three targets, never mutating other bytes", () => {
		const input = "mixed 🚀 <a> & \"q\" 'p' 日 > end";
		expect(escapeXmlText(input)).toBe("mixed 🚀 &lt;a&gt; &amp; \"q\" 'p' 日 &gt; end");
	});
});

describe("escapeXmlText — the no-escape fast path", () => {
	it("returns the empty string for empty input", () => {
		expect(escapeXmlText("")).toBe("");
	});

	it("returns the SAME string reference when nothing needs escaping (no allocation, Law 7)", () => {
		// The fast path is a real performance contract: a string with no escapable
		// character is returned as-is, not rebuilt. `Object.is` proves no copy.
		const clean = "just plain text with quotes \" ' and unicode 日本語 🚀";
		expect(Object.is(escapeXmlText(clean), clean)).toBe(true);
	});

	it("does NOT take the fast path (does allocate) as soon as one escapable appears", () => {
		const dirty = "plain then &";
		expect(Object.is(escapeXmlText(dirty), dirty)).toBe(false);
		expect(escapeXmlText(dirty)).toBe("plain then &amp;");
	});
});

describe("escapeXmlText — boundary positions", () => {
	it("escapes a target at the very start", () => {
		expect(escapeXmlText("<abc")).toBe("&lt;abc");
		expect(escapeXmlText("&abc")).toBe("&amp;abc");
	});

	it("escapes a target at the very end", () => {
		expect(escapeXmlText("abc>")).toBe("abc&gt;");
	});

	it("escapes a target surrounded by other escapables at both ends", () => {
		expect(escapeXmlText("&x<y>")).toBe("&amp;x&lt;y&gt;");
	});

	it("handles a long run of mixed content", () => {
		const input = `${"<a>&".repeat(50)}tail`;
		const expected = `${"&lt;a&gt;&amp;".repeat(50)}tail`;
		expect(escapeXmlText(input)).toBe(expected);
	});
});

describe("escapeXmlText — differential vs the removed ai implementation", () => {
	// Exhaustive over every string of length 0..3 built from an alphabet that
	// includes all three escapables plus neutral, whitespace, and quote
	// characters, so every ordering and adjacency of escapable/non-escapable up
	// to length 3 is covered: 1 + 8 + 64 + 512 = 585 inputs.
	const ALPHABET = ["&", "<", ">", "a", " ", "\n", '"', "'"];
	function corpus(): string[] {
		const out: string[] = [""];
		for (const a of ALPHABET) {
			out.push(a);
			for (const b of ALPHABET) {
				out.push(a + b);
				for (const c of ALPHABET) out.push(a + b + c);
			}
		}
		return out;
	}

	it("agrees with the naive triple-replaceAll on every short string (the migration is behavior-preserving)", () => {
		const inputs = corpus();
		expect(inputs.length).toBe(585);
		const disagreements: Array<{ input: string; owner: string; naive: string }> = [];
		for (const input of inputs) {
			const owner = escapeXmlText(input);
			const naive = naiveReference(input);
			if (owner !== naive) disagreements.push({ input, owner, naive });
		}
		expect(disagreements).toEqual([]);
	});

	it("agrees with the naive implementation on crafted adversarial strings", () => {
		const adversarial = [
			"&amp;&lt;&gt;",
			"<<<>>>&&&",
			"a&b<c>d\"e'f",
			"&lt;script&gt;alert(1)&lt;/script&gt;",
			"<script>alert('xss & stuff')</script>",
			"pure text no escapes here 🚀 日本語",
			"\n\t & \r < > ",
			"&".repeat(100),
			`${"<>".repeat(64)}&`,
			"tool_name & <arg> \"json\": 'value'",
		];
		for (const input of adversarial) {
			expect(escapeXmlText(input)).toBe(naiveReference(input));
		}
	});
});

/**
 * Behavior lock for `escapeXmlAttribute`, the canonical XML-ATTRIBUTE escaper in
 * `@veyyon/utils`. Same story as `escapeXmlText` above, one character wider: an
 * attribute value can also be broken by a literal double quote, so this escapes
 * exactly four characters — `&`, `<`, `>`, and `"` — to `&amp;`, `&lt;`, `&gt;`,
 * `&quot;`. It deliberately does NOT escape the single quote `'` (attributes in
 * this renderer are always double-quoted, so `'` is safe data), matching the
 * implementation being unified away.
 *
 * `@veyyon/ai`'s `dialect/rendering.ts` shipped its own `escapeXmlAttr`, a naive
 * `.replaceAll("&","&amp;").replaceAll('"',"&quot;").replaceAll("<","&lt;")
 * .replaceAll(">","&gt;")`. Before folding it into a (renamed) re-export of this
 * owner, the differential below proves the two produce identical output on every
 * input, so no rendered tool-call attribute changes. `naiveAttrReference` is a
 * byte-for-byte copy of that removed ai implementation.
 */

/** Byte-for-byte the `escapeXmlAttr` removed from `ai/dialect/rendering.ts`. */
function naiveAttrReference(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

describe("escapeXmlAttribute — the four escaped characters", () => {
	it("escapes ampersand, less-than, greater-than, and double quote", () => {
		expect(escapeXmlAttribute("&")).toBe("&amp;");
		expect(escapeXmlAttribute("<")).toBe("&lt;");
		expect(escapeXmlAttribute(">")).toBe("&gt;");
		expect(escapeXmlAttribute('"')).toBe("&quot;");
	});

	it("escapes a quote-bearing attribute value so it cannot break out of the attribute", () => {
		// The whole point of the attribute variant: `"` must not survive raw, or a
		// value could close the attribute and inject markup.
		expect(escapeXmlAttribute('a" onerror="x')).toBe("a&quot; onerror=&quot;x");
	});

	it("escapes all four together in place", () => {
		expect(escapeXmlAttribute('a & b < c > d " e')).toBe("a &amp; b &lt; c &gt; d &quot; e");
	});
});

describe("escapeXmlAttribute — characters it must leave alone", () => {
	it("does NOT escape the single quote (attributes here are double-quoted)", () => {
		expect(escapeXmlAttribute("it's a value")).toBe("it's a value");
	});

	it("passes through whitespace, unicode, and emoji untouched", () => {
		expect(escapeXmlAttribute("café 日本語 🚀\n\t/")).toBe("café 日本語 🚀\n\t/");
	});
});

describe("escapeXmlAttribute — the no-escape fast path", () => {
	it("returns the empty string for empty input", () => {
		expect(escapeXmlAttribute("")).toBe("");
	});

	it("returns the SAME string reference when nothing needs escaping (no allocation, Law 7)", () => {
		const clean = "plain single-quoted 'value' 日本語 🚀";
		expect(Object.is(escapeXmlAttribute(clean), clean)).toBe(true);
	});

	it("does NOT take the fast path once a double quote appears (which escapeXmlText would ignore)", () => {
		// A `"` is escapable here but NOT in escapeXmlText — this is the one-char
		// difference between the two, pinned so they cannot be conflated.
		const withQuote = 'plain then "';
		expect(Object.is(escapeXmlAttribute(withQuote), withQuote)).toBe(false);
		expect(escapeXmlAttribute(withQuote)).toBe("plain then &quot;");
		// escapeXmlText leaves the quote alone, taking its own fast path.
		expect(Object.is(escapeXmlText(withQuote), withQuote)).toBe(true);
	});
});

describe("escapeXmlAttribute — differential vs the removed ai implementation", () => {
	// Same exhaustive length-0..3 corpus as escapeXmlText, over an alphabet that
	// includes the double quote so the fourth escaped character is exercised in
	// every position and adjacency: 1 + 8 + 64 + 512 = 585 inputs.
	const ALPHABET = ["&", "<", ">", '"', "a", " ", "\n", "'"];
	function corpus(): string[] {
		const out: string[] = [""];
		for (const a of ALPHABET) {
			out.push(a);
			for (const b of ALPHABET) {
				out.push(a + b);
				for (const c of ALPHABET) out.push(a + b + c);
			}
		}
		return out;
	}

	it("agrees with the naive quad-replaceAll on every short string (the migration is behavior-preserving)", () => {
		const inputs = corpus();
		expect(inputs.length).toBe(585);
		const disagreements: Array<{ input: string; owner: string; naive: string }> = [];
		for (const input of inputs) {
			const owner = escapeXmlAttribute(input);
			const naive = naiveAttrReference(input);
			if (owner !== naive) disagreements.push({ input, owner, naive });
		}
		expect(disagreements).toEqual([]);
	});

	it("agrees with the naive implementation on crafted adversarial attribute values", () => {
		const adversarial = [
			'name="value"',
			'"><script>alert(1)</script>',
			"a & b < c > d",
			"&quot;already&quot; &amp; escaped",
			"tool_name & <arg> \"json\": 'value'",
			'"'.repeat(100),
			`${'"<'.repeat(64)}&`,
			"pure attribute value no escapes 🚀 日本語 'ok'",
		];
		for (const input of adversarial) {
			expect(escapeXmlAttribute(input)).toBe(naiveAttrReference(input));
		}
	});
});
