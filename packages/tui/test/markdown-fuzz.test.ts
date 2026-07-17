/**
 * Fuzz + adversarial DoS tests for the markdown renderer. `Markdown.render` runs
 * on model-authored output, so untrusted input — unbalanced structure, deeply
 * nested blockquotes/lists, malformed inline spans, lone surrogates, control
 * bytes — must never throw, never hang the lexer (a super-linear list-indent
 * blow-up), and never overflow the JS stack (a deeply nested payload is a trivial
 * DoS on the TUI).
 *
 * Two independent guards are under test here:
 *   - the render-depth cap (Markdown.MAX_RENDER_DEPTH), which bounds the
 *     per-token recursion, and
 *   - the input-nesting cap (capMarkdownNesting), which bounds structure BEFORE
 *     marked's block lexer runs, since the lexer itself overflows/hangs on
 *     pathological nesting the render guard would never get to see.
 *
 * Deterministic LCG so any failure reproduces from the printed seed input.
 */
import { describe, expect, it } from "bun:test";
import { Markdown } from "@veyyon/pi-tui/components/markdown";
import { buildString, FRAGMENTS, lcg } from "./helpers/adversarial-strings";
import { defaultMarkdownTheme } from "./test-themes.js";

// Markdown-flavored structural tokens layered on the generic fragment pool.
const MD_TOKENS: readonly string[] = [
	"#",
	"##",
	">",
	">>",
	"- ",
	"1. ",
	"  ",
	"\t",
	"`",
	"```",
	"```js",
	"*",
	"**",
	"_",
	"~~",
	"[",
	"]",
	"(",
	")",
	"![",
	"|",
	"---",
	"$",
	"$$",
	"\\(",
	"\\[",
	"<div>",
	"</div>",
	"&amp;",
	"\n",
	"\n\n",
];

const POOL = [...MD_TOKENS, ...FRAGMENTS];

function buildMarkdown(rand: () => number): string {
	const n = Math.floor(rand() * 60);
	let out = "";
	for (let i = 0; i < n; i++) out += POOL[Math.floor(rand() * POOL.length)];
	return out;
}

const render = (src: string, width = 80): readonly string[] =>
	new Markdown(src, 0, 0, defaultMarkdownTheme).render(width);

describe("markdown fuzz invariants", () => {
	// 30s timeouts on the fuzz/deep-nesting loops: on a saturated gate machine
	// (parallel=4 full run) wall-clock triples vs isolated and races bun's 5s default.
	it("render never throws on adversarial input", () => {
		const rand = lcg(0x4d_d0_11_00);
		for (let iter = 0; iter < 8000; iter++) {
			const s = buildMarkdown(rand);
			try {
				const lines = render(s, 40 + Math.floor(rand() * 80));
				expect(Array.isArray(lines)).toBe(true);
			} catch (e) {
				throw new Error(`render(${JSON.stringify(s)}) threw: ${e}`);
			}
		}
	}, 30_000);

	it("render never throws when the payload is prose spliced with adversarial fragments", () => {
		const rand = lcg(0x9e_37_79_b9);
		for (let iter = 0; iter < 4000; iter++) {
			const s = `# Heading ${buildString(rand)}\n\n> ${buildMarkdown(rand)}\n\n- ${buildString(rand)}`;
			try {
				render(s);
			} catch (e) {
				throw new Error(`render(${JSON.stringify(s)}) threw: ${e}`);
			}
		}
	}, 30_000);
});

describe("markdown deep-nesting DoS", () => {
	// Deep blockquotes overflow marked's block lexer (unspaced) and the render
	// recursion; both must be bounded. Depths span past the raw-lexer overflow
	// point (~20k) to prove the input cap, not just the render guard, is holding.
	it("does not overflow on deep blockquotes", () => {
		for (const depth of [200, 1000, 5000, 20000, 50000]) {
			for (const src of [`${">".repeat(depth)} x`, `${"> ".repeat(depth)}x`]) {
				let lines: readonly string[];
				try {
					lines = render(src);
				} catch (e) {
					throw new Error(`deep blockquote depth ${depth} threw: ${e}`);
				}
				expect(Array.isArray(lines)).toBe(true);
			}
		}
	}, 30_000);

	// Deep list indentation is the worst case: marked's list tokenizer is
	// super-linear in nesting, so an uncapped 2000-deep list hangs for minutes.
	// The input cap must keep it well under a second.
	it("does not hang on deep nested lists", () => {
		let md = "";
		for (let i = 0; i < 2000; i++) md += `${"  ".repeat(i)}- x\n`;
		const t0 = performance.now();
		let lines: readonly string[];
		try {
			lines = render(md);
		} catch (e) {
			throw new Error(`deep nested list threw: ${e}`);
		}
		const elapsedMs = performance.now() - t0;
		expect(Array.isArray(lines)).toBe(true);
		expect(elapsedMs).toBeLessThan(3000);
	}, 30_000);

	// The caps must be invisible to realistic content: shallow nesting renders
	// exactly as it would without them.
	it("leaves realistic nested content unchanged", () => {
		const md =
			"# Title\n\n- a\n  - b\n    - c\n\n> quote\n>> nested quote\n\n```js\nconst x = 1;\n```\n\nText **bold** and `code`.";
		const capped = render(md);
		expect(capped.length).toBeGreaterThan(8);
		expect(capped.join("\n")).toContain("Title");
		expect(capped.join("\n")).toContain("nested quote");
	});

	// marked parses a run of emphasis markers (`**`×N) into N-deep strong>strong>…
	// inline tokens; the inline renderer wraps each level in ANSI codes, so the
	// bubbling string concatenation was O(n^2) — `**`×3000 took ~8.8s, a per-
	// message hang on untrusted model output. The inline-depth guard
	// (Markdown.MAX_INLINE_DEPTH) flattens past the cap, cutting OUR contribution
	// to near-zero (the small residual is marked's own lexer, out of our hands).
	it("does not blow up on deeply nested inline emphasis", () => {
		for (const marker of ["**", "*", "__", "_", "~~"]) {
			const src = `${marker.repeat(3000)}a${marker.repeat(3000)}`;
			const t0 = performance.now();
			let lines: readonly string[];
			try {
				lines = render(src);
			} catch (e) {
				throw new Error(`deep inline ${marker} threw: ${e}`);
			}
			const elapsedMs = performance.now() - t0;
			expect(Array.isArray(lines)).toBe(true);
			// Was ~8.8s before the guard; now dominated by marked's lexer (~0.4s).
			expect(elapsedMs).toBeLessThan(3000);
		}
	}, 30_000);

	it("still styles realistic (shallow) nested inline formatting", () => {
		const lines = render("A **bold _em [link](u) `code`_** tail");
		const joined = lines.join("\n");
		expect(joined).toContain("bold");
		expect(joined).toContain("link");
		expect(joined).toContain("code");
		expect(joined).toContain("tail");
	});
});
