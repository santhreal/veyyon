/**
 * SPEC-ONE-PLACE-AUDIT F6: single canonical `stripAnsi` (CSI+OSC superset)
 * imported by `tiny/message-preproc.ts` and the browser-bundled
 * `@veyyon/tool-render` (via `src/util.ts`), replacing two divergent copies
 * (one SGR-only, two byte-identical CSI+OSC forks).
 *
 * The repo cannot have a single implementation: this one runs in the TUI and in
 * a browser bundle that may not import Node built-ins, and `strip_ansi` in
 * `crates/veyyon-shell/src/minimizer/primitives.rs` runs inside the shell's
 * output minimizer. Two implementations of one contract is fine. Two
 * implementations of two contracts is what was there, so the cases now live
 * outside both languages in `fixtures/ansi-strip-corpus.json` and both suites
 * read them; the Rust half is `crates/veyyon-shell/tests/ansi_strip_contract.rs`.
 */
import { describe, expect, it } from "bun:test";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { collectPackageSources } from "./support/package-sources";

describe("stripAnsi", () => {
	it("strips SGR color/style sequences", () => {
		expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
	});

	it("strips non-SGR CSI sequences (cursor movement, erase)", () => {
		expect(stripAnsi("\x1b[2K\x1b[1Ahello")).toBe("hello");
	});

	it("strips OSC sequences terminated by BEL", () => {
		expect(stripAnsi("\x1b]0;window title\x07visible")).toBe("visible");
	});

	it("strips OSC sequences terminated by ST (ESC \\\\)", () => {
		expect(stripAnsi("\x1b]8;;https://example.com\x1b\\link text\x1b]8;;\x1b\\")).toBe("link text");
	});

	it("leaves plain text untouched", () => {
		expect(stripAnsi("plain text, no escapes")).toBe("plain text, no escapes");
	});

	/**
	 * Parameter bytes are the spec's 0x30-0x3f, which includes `:`.
	 *
	 * This one is here because it was wrong: the pattern read parameters as
	 * `[0-9;?]`, so a true-color SGR written with colon subparameters kept
	 * `38:2:255:0:0m` as visible text. libvte and several test runners emit that
	 * form, and the Rust half had always stripped it.
	 */
	it("strips a CSI whose parameters use colon subparameters", () => {
		expect(stripAnsi("\x1b[38:2:255:0:0mtrue color\x1b[0m")).toBe("true color");
		expect(stripAnsi("\x1b[<0;1;2Mclick")).toBe("click");
	});

	/**
	 * An escape that opens no sequence is dropped, and only the escape.
	 *
	 * Also wrong before: the escape stayed as text, which is not a fixed point.
	 * The text after it has always been the part that matters, since that is what
	 * a capture cut at a buffer boundary looks like.
	 */
	it("drops a stray escape and keeps the text after it", () => {
		expect(stripAnsi("a\x1bb")).toBe("ab");
		expect(stripAnsi("error: \x1b[3")).toBe("error: [3");
		expect(stripAnsi("\x1b]8;;https://example.com")).toBe("]8;;https://example.com");
	});

	/**
	 * Stripping twice is stripping once.
	 *
	 * The case below is from the Rust half's fuzzer. Keeping a stray escape let a
	 * removal push it against a following `[` and MAKE a sequence, so the same
	 * string stripped to `" ][:\x1b[["` on one pass and `" ][:"` on the next: a
	 * filter's answer depended on how many times it had run.
	 */
	it("is a fixed point, so a second pass changes nothing", () => {
		const once = stripAnsi(" ][:\x1b\x1b[[[[");

		expect(once).toBe(" ][:[[");
		expect(stripAnsi(once)).toBe(once);
	});

	/** Line endings are a different primitive's decision and are passed through. */
	it("preserves line endings verbatim", () => {
		expect(stripAnsi("\x1b[32mok\x1b[0m\r\nnext\n")).toBe("ok\r\nnext\n");
	});
});

/**
 * The corpus shared with the Rust implementation.
 *
 * Read from disk rather than restated here, because a case restated is a case
 * that can be edited on one side. Every case is asserted for exact equality and
 * for idempotence, the same two rules the Rust suite applies.
 */
describe("stripAnsi against the shared cross-language corpus", () => {
	type Case = { name: string; why: string; input: string; expected: string };

	async function corpus(): Promise<Case[]> {
		const url = new URL("../../../fixtures/ansi-strip-corpus.json", import.meta.url);
		const parsed = (await Bun.file(url).json()) as { cases: Case[] };
		return parsed.cases;
	}

	/**
	 * NON-VACUITY: the corpus really loaded and really holds both sequence kinds.
	 * Without this, the two rules below pass on an empty list.
	 */
	it("loads the corpus the Rust suite reads", async () => {
		const cases = await corpus();

		expect(cases.length).toBeGreaterThanOrEqual(18);
		expect(cases.map(c => c.name)).toContain("osc_hyperlink_st");
		expect(cases.map(c => c.name)).toContain("csi_colon_subparameters");
		expect(cases.filter(c => c.input.includes("\x1b["))).not.toEqual([]);
		expect(cases.filter(c => c.input.includes("\x1b]"))).not.toEqual([]);
		for (const c of cases) expect(c.why.trim(), `${c.name} should say why it exists`).not.toBe("");
	});

	/** Exact bytes, per case, with the case's own reason in the failure message. */
	it("strips every case to exactly its expected text", async () => {
		for (const c of await corpus()) {
			expect(stripAnsi(c.input), `${c.name}: ${c.why}`).toBe(c.expected);
		}
	});

	/** And every case settles in one pass, with no escape left to change a second. */
	it("is a fixed point for every case", async () => {
		for (const c of await corpus()) {
			const once = stripAnsi(c.input);

			expect(stripAnsi(once), `${c.name} should be a fixed point`).toBe(once);
			expect(once.includes("\x1b"), `${c.name} should leave no escape byte`).toBe(false);
		}
	});
});

// Repo-wide source lock: stripAnsi has exactly ONE owner,
// packages/utils/src/strip-ansi.ts (the CSI+OSC superset). Local copies drift:
// the sweep that landed this lock found six, three under one name with three
// DIFFERENT behaviors (SGR-only, full CSI, Node stripVTControlCharacters). The
// owner's docstring is explicit that an SGR-only strip is materially different
// and must not reuse this name, so any `function stripAnsi` outside the owner is
// a violation. Both src and test are scanned, since a test-helper copy is still a
// second definition that drifts (that is where these copies hid). Import the
// owner; a narrower stripper needs its own honest name (e.g. stripSgr).
const OWNER = "utils/src/strip-ansi.ts";
const STRIPANSI_DEF = /function\s+stripAnsi\s*\(/;

// The monorepo walk + skip-set is shared with every other source-ownership lock
// (see ./support/package-sources).
describe("stripAnsi source lock", () => {
	it("no source or test file defines a local stripAnsi outside the owner", async () => {
		const offenders: string[] = [];
		for (const { rel, text } of await collectPackageSources({ dirs: ["src", "test"], includeTests: true })) {
			if (rel === OWNER) continue;
			if (STRIPANSI_DEF.test(text)) offenders.push(rel);
		}
		expect(
			offenders,
			"local stripAnsi copies: import it from @veyyon/utils; a narrower stripper needs its own name",
		).toEqual([]);
	});
});
