/**
 * ONE-PLACE lock for the ANSI escape primitives.
 *
 * Why this suite exists: five byte strings were declared sixteen times across `@veyyon/tui` and
 * `@veyyon/coding-agent` under eleven names. `\x1b[0m` was `SEGMENT_RESET` in `tui.ts` and `deccara.ts`,
 * `RESET` in `tools/terminal-output.ts` and `modes/components/sun.ts`, and `RESERVED_IMAGE_ROW` in
 * `components/image.ts`. `\x1b[39m` was `FG_RESET` three times and `ANSI_FG_RESET` once. `\x1b\\` was `ST`,
 * `OSC_TERMINATOR_ST` and `SIXEL_END_SEQUENCE`. `\x1b]` was `OSC` and `OSC_INTRODUCER`. `\x1b` was `ESC`
 * twice.
 *
 * Eleven names for five values is worse than eleven copies of one name: grep `SEGMENT_RESET` and you find two
 * of the five sites emitting those bytes, with nothing pointing at the other three, so "where is the reset
 * written" has no answer. The bytes are pinned here because they are a protocol a terminal parses, not a
 * choice this codebase gets to make, and the ownership cases fail if a twelfth name appears.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	BEL,
	CSI,
	ESC,
	OSC,
	OSC66,
	SGR_BG_RESET,
	SGR_FG_RESET,
	SGR_INTENSITY_RESET,
	SGR_RESET,
	SGR_RESET_SHORT,
	SGR_SEQUENCE_PATTERN,
	sgrSequence,
	ST,
} from "@veyyon/tui/ansi";

const TUI_SRC = path.join(import.meta.dir, "..", "src");
const CODING_AGENT_SRC = path.resolve(import.meta.dir, "../../coding-agent/src");

describe("the ANSI primitives", () => {
	/** The escape byte. Every sequence in this module and every caller's composition starts with it. */
	it("uses a single 0x1b byte for ESC", () => {
		expect(ESC).toBe("\x1b");
		expect(ESC).toHaveLength(1);
		expect(ESC.charCodeAt(0)).toBe(0x1b);
	});

	/**
	 * `ESC [`, the Control Sequence Introducer, which starts every cursor move, erase and SGR change.
	 *
	 * Named CSI rather than `ESC`, and that distinction is the point. `packages/metaharness/src/runner.ts`
	 * declared `const ESC = "\x1b["`, so one name meant the escape byte here and the full introducer there, and
	 * its `${ESC}0m` read as an escape byte followed by the text "0m" when it was really a complete SGR reset. A
	 * reader who learned the name in one package carried the wrong bytes into the other.
	 */
	it("introduces a control sequence with ESC [", () => {
		expect(CSI).toBe("\x1b[");
		expect(CSI).toBe(`${ESC}[`);
		expect(CSI).toHaveLength(2);
	});

	/**
	 * Both SGR constants are DERIVED from the introducer rather than spelling `\x1b[` again. They used to hold
	 * the introducer inline while this same module owned `ESC`, which is the duplication this module exists to
	 * remove, one level down and inside the owner itself.
	 */
	it("builds both SGR resets from the introducer", () => {
		expect(SGR_RESET).toBe(`${CSI}0m`);
		expect(SGR_FG_RESET).toBe(`${CSI}39m`);
		expect(SGR_RESET.startsWith(CSI)).toBeTrue();
		expect(SGR_FG_RESET.startsWith(CSI)).toBeTrue();
	});

	/** `ESC ]`, the Operating System Command introducer, used for hyperlinks, titles and progress reports. */
	it("introduces an OSC with ESC ]", () => {
		expect(OSC).toBe("\x1b]");
		expect(OSC.startsWith(ESC)).toBeTrue();
	});

	/**
	 * `ESC \`, the String Terminator. A terminal also accepts a bare BEL to close an OSC, which is why some
	 * call sites emit BEL, but this is the standard form and the one a parser must always accept.
	 */
	it("terminates a string sequence with ESC backslash", () => {
		expect(ST).toBe("\x1b\\");
		expect(ST).toHaveLength(2);
		expect(ST.startsWith(ESC)).toBeTrue();
	});

	/** `ESC [ 0 m`, which clears every attribute: colour, weight, italics, inverse. */
	it("resets all attributes with SGR 0", () => {
		expect(SGR_RESET).toBe("\x1b[0m");
	});

	/** `ESC [ 39 m`, the default foreground only. */
	it("resets the foreground colour with SGR 39", () => {
		expect(SGR_FG_RESET).toBe("\x1b[39m");
	});

	/**
	 * The distinction that makes both resets necessary, and the reason merging them would be a real bug: a
	 * gradient or shimmer closes a coloured run with the FOREGROUND reset so the bold or inverse the
	 * surrounding text set survives. Closing with the full reset drops those too, and the damage lands on the
	 * text AFTER the coloured run, which is the hardest place to notice it.
	 */
	it("keeps the foreground reset narrower than the full reset", () => {
		expect(SGR_FG_RESET).not.toBe(SGR_RESET);
		expect(SGR_RESET).toContain("[0m");
		expect(SGR_FG_RESET).toContain("[39m");
	});

	/** Each is one well-formed sequence: a single ESC, and nothing after the final byte. */
	it("holds exactly one escape sequence per constant", () => {
		for (const sequence of [OSC, ST, SGR_RESET, SGR_FG_RESET]) {
			expect(sequence.split(ESC)).toHaveLength(2);
			expect(sequence).not.toContain("\n");
		}
	});
});

describe("the primitives added after the first cut", () => {
	/**
	 * `0x07`, the legacy OSC terminator. Every terminal accepts it in place of `ESC \`, and emitters in this tree
	 * use both deliberately, so a PARSER has to accept either. It was declared three times in
	 * `@veyyon/coding-agent` as `BEL`, `OSC_TERMINATOR_BEL` and `SIXEL_END_BELL`, which meant the sixel scanner
	 * and the paste decoder each decided independently what closes a sequence.
	 */
	it("uses a single 0x07 byte for BEL", () => {
		expect(BEL).toBe("\x07");
		expect(BEL).toHaveLength(1);
		expect(BEL.charCodeAt(0)).toBe(0x07);
	});

	/** BEL and ST are alternatives for the same job, so they must be different bytes and neither may contain the other. */
	it("keeps BEL and ST as distinct OSC terminators", () => {
		expect(BEL).not.toBe(ST);
		expect(ST.includes(BEL)).toBeFalse();
		expect(BEL.includes(ST)).toBeFalse();
	});

	/**
	 * `ESC [ 49 m`, the background reset and the counterpart of the foreground one. Two modules in two packages
	 * had a copy, and both use it to close a run of coloured cells: a run left open bleeds its background across
	 * the rest of the row.
	 */
	it("resets the background with SGR 49", () => {
		expect(SGR_BG_RESET).toBe("\x1b[49m");
		expect(SGR_BG_RESET).toBe(`${CSI}49m`);
		expect(SGR_BG_RESET).not.toBe(SGR_FG_RESET);
	});

	/**
	 * `ESC [ 22 m` cancels BOTH bold and dim, which is why the two names it used to carry were each wrong.
	 * `BOLD_CLOSE` in the shimmer and `DIM_OFF` in the diff renderer named half of it apiece, and the inaccuracy
	 * is a live trap: emitting "DIM_OFF" after dim text nested inside a bold run also cancels the bold, so the
	 * rest of the line silently loses weight. There is no sequence that turns off only one of the two.
	 */
	it("resets both intensities with a single SGR 22", () => {
		expect(SGR_INTENSITY_RESET).toBe("\x1b[22m");
		expect(SGR_INTENSITY_RESET).toBe(`${CSI}22m`);
		// Distinct from the full reset, which is the whole reason it exists: SGR 0 would also drop colour.
		expect(SGR_INTENSITY_RESET).not.toBe(SGR_RESET);
	});

	/**
	 * `ESC ] 66 ;`, Kitty's text-sizing introducer. A writer and a detector both need these exact bytes:
	 * `tui/src/utils.ts` scans for the sequence while `components/markdown.ts` decides whether a line contains
	 * one, and each had its own copy. A detector that stopped matching the writer would silently mis-measure
	 * every wide grapheme on the line.
	 */
	it("introduces OSC 66 from the OSC introducer", () => {
		expect(OSC66).toBe("\x1b]66;");
		expect(OSC66).toBe(`${OSC}66;`);
		expect(OSC66.startsWith(OSC)).toBeTrue();
	});

	/**
	 * The retired names, checked across both package trees. Keyed on the declaration so a comment recording the
	 * history is still allowed.
	 */
	it("declares none of the retired names", async () => {
		const RETIRED = [
			"ANSI_BG_RESET",
			"BG_RESET",
			"BOLD_CLOSE",
			"DIM_OFF",
			"OSC_TERMINATOR_BEL",
			"SIXEL_END_BELL",
			"OSC66_PREFIX",
			"OSC66_LINE_PREFIX",
		];
		const offenders: string[] = [];
		for (const tree of [TUI_SRC, CODING_AGENT_SRC]) {
			for (const file of new Bun.Glob("**/*.ts").scanSync(tree)) {
				const full = path.join(tree, file);
				if (full === path.join(TUI_SRC, "ansi.ts")) continue;
				const text = await Bun.file(full).text();
				for (const name of RETIRED) {
					if (new RegExp(`^\\s*(?:export )?const ${name}\\b`, "m").test(text)) offenders.push(`${file}: ${name}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	/**
	 * What deliberately STAYS inline, recorded so the boundary is a decision rather than an inconsistency.
	 *
	 * A one-off attribute in a formatting expression, `\x1b[1m` around a label or `\x1b[2m` around a hint, has no
	 * counterpart anywhere: nothing parses it, nothing has to agree with it, and hoisting fifteen such sites
	 * would trade readable local formatting for fifteen imports. This module owns the bytes whose duplication has
	 * a CONSEQUENCE, which means a value some other module must match. Both bold and dim openers are therefore
	 * absent here on purpose.
	 */
	it("does not own one-off inline attributes", async () => {
		const owner = await Bun.file(path.join(TUI_SRC, "ansi.ts")).text();
		expect(owner).not.toContain("SGR_BOLD");
		expect(owner).not.toContain("SGR_DIM");
		// The intensity RESET is here, though, precisely because two modules had to agree on it.
		expect(owner).toContain("export const SGR_INTENSITY_RESET");
	});

	/**
	 * The one duplicate that cannot be removed, recorded with its reason so it is not re-found as an oversight.
	 *
	 * `utils/src/sanitize-text.ts` declares `ESC_CHAR = "\x1b"`, the same byte this module owns as `ESC`.
	 * `@veyyon/tui` depends on `@veyyon/utils`, not the reverse, so utils cannot import this owner, and moving the
	 * owner down into utils would put a terminal-protocol module in a package that knows nothing about terminals.
	 * The duplicate is one byte with no counterpart to disagree with, which is the cheapest kind to leave.
	 */
	it("accepts the escape byte's copy in the lower layer", async () => {
		const sanitize = await Bun.file(path.resolve(import.meta.dir, "../../utils/src/sanitize-text.ts")).text();
		expect(sanitize).toContain('const ESC_CHAR = "\\x1b";');
		expect(sanitize).not.toContain("@veyyon/tui");
	});
});

describe("primitive ownership", () => {
	/** Every module that used to declare one of the five values, and the value it declared. */
	const FORMER_DECLARERS: Array<[string, string]> = [
		[path.join(TUI_SRC, "utils.ts"), "ESC"],
		[path.join(TUI_SRC, "stdin-buffer.ts"), "ESC"],
		[path.join(TUI_SRC, "latex-to-unicode.ts"), "SGR_FG_RESET"],
		[path.join(TUI_SRC, "tui.ts"), "SGR_RESET"],
		[path.join(TUI_SRC, "deccara.ts"), "SGR_RESET"],
		[path.join(TUI_SRC, "components/image.ts"), "SGR_RESET"],
		[path.join(CODING_AGENT_SRC, "tui/hyperlink.ts"), "ST"],
		[path.join(CODING_AGENT_SRC, "modes/gradient-highlight.ts"), "SGR_FG_RESET"],
		[path.join(CODING_AGENT_SRC, "modes/components/segment-track.ts"), "SGR_FG_RESET"],
		[path.join(CODING_AGENT_SRC, "modes/theme/shimmer.ts"), "SGR_FG_RESET"],
		[path.join(CODING_AGENT_SRC, "tools/terminal-output.ts"), "SGR_RESET"],
		[path.join(CODING_AGENT_SRC, "modes/components/sun.ts"), "SGR_RESET"],
		[path.join(CODING_AGENT_SRC, "utils/sixel.ts"), "ST"],
		[path.join(CODING_AGENT_SRC, "utils/enhanced-paste.ts"), "ST"],
	];

	/**
	 * The positive half: every former declarer imports the name it used to define. A module that reintroduced
	 * the literal under a fresh name would pass a scan keyed on the OLD names and fail here.
	 */
	it("has every former declarer importing the primitive it used to define", async () => {
		for (const [file, name] of FORMER_DECLARERS) {
			const text = await Bun.file(file).text();
			expect(text).toMatch(new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from "(?:\\.\\.?/|@veyyon/tui/)ansi";`));
		}
	});

	/**
	 * The ratchet. None of the eleven old names may be declared anywhere again, in either package. Keyed on
	 * the declaration form rather than on a mention, so a doc comment naming the history is fine.
	 */
	it("leaves none of the eleven retired names declared in either package", async () => {
		const retired = ["SEGMENT_RESET", "FG_RESET", "ANSI_FG_RESET", "OSC_INTRODUCER", "OSC_TERMINATOR_ST"];
		const offenders: string[] = [];
		for (const [root, glob] of [
			[TUI_SRC, "**/*.ts"],
			[CODING_AGENT_SRC, "**/*.ts"],
		] as const) {
			for (const relative of new Bun.Glob(glob).scanSync(root)) {
				const text = await Bun.file(path.join(root, relative)).text();
				for (const name of retired) {
					if (new RegExp(`^\\s*(?:export )?const ${name}\\b`, "m").test(text)) {
						offenders.push(`${relative} declares ${name}`);
					}
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	/**
	 * The non-vacuity twin: the scan above would pass by reading nothing if a glob broke, so this proves it
	 * covers both trees and really can see a declaration when one is there.
	 */
	it("scans both package trees and can see a const declaration", async () => {
		const tuiFiles = [...new Bun.Glob("**/*.ts").scanSync(TUI_SRC)];
		const agentFiles = [...new Bun.Glob("**/*.ts").scanSync(CODING_AGENT_SRC)];
		expect(tuiFiles).toContain("ansi.ts");
		expect(agentFiles.length).toBeGreaterThan(500);
		const owner = await Bun.file(path.join(TUI_SRC, "ansi.ts")).text();
		expect(/^export const SGR_RESET\b/m.test(owner)).toBeTrue();
	});

	/**
	 * The owner stays a leaf. Every one of the sixteen duplicates existed because the value was trivial to
	 * retype and no cheap owner existed to import; an import here would recreate that pressure.
	 */
	it("imports nothing", async () => {
		const owner = await Bun.file(path.join(TUI_SRC, "ansi.ts")).text();
		expect(owner).not.toMatch(/^\s*import\s/m);
		expect(owner).not.toMatch(/\bfrom\s+"/);
	});

	/**
	 * The one deliberate exception, recorded so it stays a decision instead of becoming the precedent for the
	 * next copy. `utils/qrcode.ts` documents itself as dependency-free so the collab join-code command renders
	 * without pulling anything into the bundle, and importing even a zero-import leaf would end that for five
	 * bytes. If that module ever grows a real import, its `ANSI_RESET` should come from here.
	 */
	it("exempts the dependency-free QR renderer, which keeps its own reset", async () => {
		const qrcode = await Bun.file(path.join(CODING_AGENT_SRC, "utils/qrcode.ts")).text();
		expect(qrcode).toContain('const ANSI_RESET = "\\x1b[0m";');
		expect(qrcode).toContain("zero dependencies");
		// The exemption is only defensible while the claim is true.
		expect(qrcode).not.toMatch(/^\s*import\s/m);
	});

	/**
	 * The cross-package ratchet for the introducer. `metaharness` cannot import `@veyyon/tui` (it does not depend
	 * on it, and one string is no reason to add a dependency), so the requirement is that nobody calls the
	 * introducer `ESC`. Keyed on the declaration, so the name is free to mean the escape byte anywhere.
	 */
	it("lets no module call the introducer ESC", async () => {
		const offenders: string[] = [];
		const trees = [TUI_SRC, CODING_AGENT_SRC, path.resolve(import.meta.dir, "../../metaharness/src")];
		for (const tree of trees) {
			for (const file of new Bun.Glob("**/*.ts").scanSync(tree)) {
				const full = path.join(tree, file);
				if (full === path.join(TUI_SRC, "ansi.ts")) continue;
				const text = await Bun.file(full).text();
				if (/^\s*(?:export )?const ESC = "\\x1b\[";/m.test(text)) offenders.push(full);
			}
		}
		expect(offenders).toEqual([]);
		// Non-vacuity: metaharness really does declare the introducer, under the right name.
		const runner = await Bun.file(path.resolve(import.meta.dir, "../../metaharness/src/runner.ts")).text();
		expect(runner).toContain('const CSI = "\\x1b[";');
	});
});

/**
 * The SGR PATTERN, which is the same disease one level up: a grammar rather than a byte string.
 *
 * `\x1b\[[0-9;:]*m` was written out four times under four names, in `utils.ts`, `tui.ts`,
 * `components/markdown.ts` and `coding-agent/src/tools/terminal-output.ts`. Three were
 * byte-identical and differed only in flags; the fourth had already drifted to `[0-9;]` with no
 * colon, so a truecolor SGR written with colon subparameters did not match it at all and the
 * row it was re-rendering lost its colour. That is the copies-drift failure stated as a fact
 * rather than a worry, and it is why the pattern needs an owner even though it is not a
 * constant a terminal parses.
 */
describe("the SGR sequence pattern", () => {
	/** The grammar itself, asserted as the string so a silent widening is visible in the diff. */
	it("accepts digits, semicolons and colons between the introducer and the m", () => {
		expect(SGR_SEQUENCE_PATTERN).toBe("\\x1b\\[([0-9;:]*)m");
	});

	/**
	 * A fresh object per call, which is the reason this is a factory and not a shared `RegExp`.
	 *
	 * The four callers need `g`, `g`, `y` and `g`, and a global or sticky `RegExp` carries
	 * `lastIndex` across uses. Sharing one object between a sticky scan in the markdown renderer
	 * and a global strip in the frame differ would make each depend on where the other stopped.
	 */
	it("hands out a new RegExp each time, with the caller's flags", () => {
		const first = sgrSequence("g");
		const second = sgrSequence("y");
		expect(first).not.toBe(second);
		expect(first.flags).toBe("g");
		expect(second.flags).toBe("y");
		first.lastIndex = 5;
		expect(sgrSequence("g").lastIndex).toBe(0);
	});

	/** What it matches, including the colon spelling the fourth copy could not see. */
	it("matches both truecolor spellings and captures the parameters", () => {
		const semicolons = sgrSequence("").exec("\x1b[38;2;255;0;0m");
		expect(semicolons?.[0]).toBe("\x1b[38;2;255;0;0m");
		expect(semicolons?.[1]).toBe("38;2;255;0;0");
		const colons = sgrSequence("").exec("\x1b[38:2:255:0:0m");
		expect(colons?.[0]).toBe("\x1b[38:2:255:0:0m");
		expect(colons?.[1]).toBe("38:2:255:0:0");
		expect(sgrSequence("").exec("\x1b[0m")?.[1]).toBe("0");
		// The parameterless spelling, whose capture is empty and which still means a full reset.
		expect(sgrSequence("").exec(SGR_RESET_SHORT)?.[1]).toBe("");
	});

	/**
	 * And what it must NOT match, which is the half a widened class would break.
	 *
	 * `?` `<` `=` `>` are parameter bytes in the CSI grammar that `@veyyon/utils/strip-ansi`
	 * owns, and an `ESC [ ?25 m` is not a colour change. Widening this class to the spec's full
	 * `0x30-0x3f` would make all four callers treat a private-mode sequence as a style and
	 * replay it into the render.
	 */
	it("does not match a private-mode sequence or a non-m final", () => {
		expect(sgrSequence("").test("\x1b[?25m")).toBe(false);
		expect(sgrSequence("").test("\x1b[2J")).toBe(false);
		expect(sgrSequence("").test("\x1b[H")).toBe(false);
		expect(sgrSequence("").test("[31m")).toBe(false);
	});

	/**
	 * The ratchet: no module writes the pattern out again.
	 *
	 * Keyed on the escape-bracket-through-m shape rather than on a name, because the four copies
	 * had four different names and a name-based check would have found none of them.
	 */
	it("is spelled in no other module", async () => {
		const literal = /\/\\x1b\\\[[^/]*m\//;
		const offenders: string[] = [];
		for (const tree of [TUI_SRC, CODING_AGENT_SRC]) {
			for (const file of new Bun.Glob("**/*.ts").scanSync(tree)) {
				const full = path.join(tree, file);
				if (full === path.join(TUI_SRC, "ansi.ts")) continue;
				const text = await Bun.file(full).text();
				for (const [index, line] of text.split("\n").entries()) {
					if (literal.test(line)) offenders.push(`${path.relative(path.join(TUI_SRC, ".."), full)}:${index + 1}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	/** Non-vacuity for the ratchet: the detector really does recognise the shape it bans. */
	it("would catch a fifth copy", () => {
		const literal = /\/\\x1b\\\[[^/]*m\//;
		expect(literal.test('const SGR = /\\x1b\\[[0-9;:]*m/g;')).toBe(true);
		expect(literal.test('const SGR = /\\x1b\\[([0-9;]*)m/g;')).toBe(true);
		expect(literal.test('const CSI = /\\x1b\\[[0-?]*[ -/]*[@-~]/g;')).toBe(false);
	});
});

/**
 * The VALUE-keyed ratchet, which is the one the name-keyed check above cannot be.
 *
 * `declares none of the retired names` lists the eleven names the first cut removed, so it holds
 * those eleven down and nothing else: a twelfth copy under a twelfth name walks straight past it,
 * which is exactly what happened. Nine more inline copies of these bytes accumulated afterwards,
 * under `reset`, `TRANSPARENT_BG_ANSI`, `keywordReset`, and several with no name at all, written
 * directly into a template or a `replaceAll` argument. A check keyed on the BYTES cannot be
 * evaded by naming, because the bytes are the thing a terminal parses and there is only one way
 * to spell them.
 */
describe("nobody writes the reset bytes again", () => {
	/** The four resets this module owns, with the name to import instead of each. */
	const OWNED: Array<[string, string]> = [
		["\\x1b\\[0m", "SGR_RESET"],
		["\\x1b\\[39m", "SGR_FG_RESET"],
		["\\x1b\\[49m", "SGR_BG_RESET"],
		["\\x1b\\[22m", "SGR_INTENSITY_RESET"],
	];

	/**
	 * Code only, not prose. A doc comment naming the sequence it is talking about is how these
	 * are explained, and banning that would make the explanations impossible to write.
	 */
	function codeLines(text: string): Array<[number, string]> {
		const out: Array<[number, string]> = [];
		let inBlockComment = false;
		for (const [index, raw] of text.split("\n").entries()) {
			const line = raw.trim();
			if (inBlockComment) {
				if (line.includes("*/")) inBlockComment = false;
				continue;
			}
			if (line.startsWith("/*")) {
				if (!line.includes("*/")) inBlockComment = true;
				continue;
			}
			if (line.startsWith("//") || line.startsWith("*")) continue;
			out.push([index + 1, raw]);
		}
		return out;
	}

	it("declares each reset in one place and imports it everywhere else", async () => {
		const offenders: string[] = [];
		for (const tree of [TUI_SRC, CODING_AGENT_SRC]) {
			for (const file of new Bun.Glob("**/*.ts").scanSync(tree)) {
				const full = path.join(tree, file);
				if (full === path.join(TUI_SRC, "ansi.ts")) continue;
				// The dependency-free QR renderer keeps its own, for the reason recorded above.
				if (full === path.join(CODING_AGENT_SRC, "utils", "qrcode.ts")) continue;
				const text = await Bun.file(full).text();
				for (const [line, content] of codeLines(text)) {
					for (const [bytes, owner] of OWNED) {
						if (content.includes(bytes)) offenders.push(`${file}:${line} spells ${owner}`);
					}
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	/**
	 * Non-vacuity, in both directions: the scan reads code and skips prose.
	 *
	 * Without the first half, a broken glob or a broken comment-stripper would report a clean
	 * tree forever. Without the second, the check would ban the doc comments that explain why
	 * these constants exist.
	 */
	it("reads code lines and skips comments", () => {
		const sample = ['/** A doc mentioning \\x1b[0m. */', "// Also \\x1b[39m here.", 'const bad = "\\x1b[49m";'].join("\n");
		const lines = codeLines(sample);
		expect(lines).toHaveLength(1);
		expect(lines[0]?.[1]).toContain("\\x1b\\[49m".replace("\\[", "["));
	});
});
