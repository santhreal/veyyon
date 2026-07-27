/**
 * ONE-PLACE lock for the bracketed-paste markers themselves.
 *
 * Why this suite exists: the sibling suite `paste-cap-owner.test.ts` locked the 64 MiB paste BOUND to one
 * owner while the two byte strings that define the protocol were still declared four times. `PASTE_START` /
 * `PASTE_END` in bracketed-paste.ts, `BRACKETED_PASTE_START` / `BRACKETED_PASTE_END` in stdin-buffer.ts, and
 * a third copy in `custom-editor.ts` plus a fourth in its co-located test, over in `@veyyon/coding-agent`.
 *
 * Three detectors run over the same terminal input at different layers. A copy edited to a different
 * sequence makes one layer stop recognising a paste while the others still do, and the symptom is escape
 * bytes leaking into the editor rather than any error, so the drift is invisible until a user pastes. The
 * markers are now exported from bracketed-paste.ts, which already documented itself as the one owner of the
 * paste bound, and this suite fails if a second copy of either literal reappears.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { BracketedPasteHandler, PASTE_END, PASTE_START } from "@veyyon/tui/bracketed-paste";

const SRC_DIR = path.join(import.meta.dir, "..", "src");
const CODING_AGENT_SRC = path.resolve(import.meta.dir, "../../coding-agent/src");

describe("the bracketed-paste markers", () => {
	/**
	 * The exact bytes xterm's bracketed-paste mode emits. Pinned as literals rather than derived, because
	 * these are what a terminal sends and no expression in this codebase gets to choose them.
	 */
	it("are CSI 200 ~ and CSI 201 ~", () => {
		expect(PASTE_START).toBe("\x1b[200~");
		expect(PASTE_END).toBe("\x1b[201~");
	});

	/**
	 * A start marker mistaken for an end marker would terminate a paste at its own opening byte, delivering
	 * an empty payload and leaking the whole pasted body as keystrokes.
	 */
	it("are distinct from each other", () => {
		expect(PASTE_START).not.toBe(PASTE_END);
	});

	/**
	 * Each is a single escape sequence: one ESC, and no embedded newline or second ESC. `indexOf` scans for
	 * these in a raw byte stream, so a marker containing a newline would split across the line-oriented
	 * paths that also read that stream.
	 */
	it("are single escape sequences with no embedded newline", () => {
		for (const marker of [PASTE_START, PASTE_END]) {
			expect(marker.startsWith("\x1b[")).toBeTrue();
			expect(marker.endsWith("~")).toBeTrue();
			expect(marker.split("\x1b")).toHaveLength(2);
			expect(marker).not.toContain("\n");
		}
	});
});

describe("the handler round-trips through the exported markers", () => {
	/**
	 * The behavioural half. The literals above could be right while the handler used something else, so this
	 * drives a real paste through `BracketedPasteHandler` using only the exported markers and checks the
	 * payload comes back exactly.
	 */
	it("extracts a payload wrapped in the exported markers", () => {
		const handler = new BracketedPasteHandler();
		const result = handler.process(`${PASTE_START}hello world${PASTE_END}rest`);
		expect(result.handled).toBeTrue();
		if (!result.handled) throw new Error("paste was not handled");
		expect(result.pasteContent).toBe("hello world");
		expect(result.remaining).toBe("rest");
		expect(result.prefix).toBeUndefined();
	});

	/** Bytes that merely shared the chunk are handed back as prefix, not folded into the payload. */
	it("splits input that arrived before the start marker off as prefix", () => {
		const handler = new BracketedPasteHandler();
		const result = handler.process(`ab${PASTE_START}payload${PASTE_END}`);
		expect(result.handled).toBeTrue();
		if (!result.handled) throw new Error("paste was not handled");
		expect(result.prefix).toBe("ab");
		expect(result.pasteContent).toBe("payload");
	});

	/** A marker split across two writes still assembles, which is why the markers are matched and not parsed. */
	it("assembles a paste whose end marker arrives in a later chunk", () => {
		const handler = new BracketedPasteHandler();
		const first = handler.process(`${PASTE_START}chunk one `);
		expect(first.handled).toBeTrue();
		if (!first.handled) throw new Error("paste was not handled");
		expect(first.pasteContent).toBeUndefined();
		const second = handler.process(`chunk two${PASTE_END}`);
		expect(second.handled).toBeTrue();
		if (!second.handled) throw new Error("paste was not handled");
		expect(second.pasteContent).toBe("chunk one chunk two");
	});
});

describe("marker ownership", () => {
	/**
	 * The ratchet across both packages. Four modules held a copy, and each copy is one line that looks
	 * harmless in isolation, so the only durable guard is a scan.
	 */
	it("declares each marker literal exactly once, in bracketed-paste.ts", async () => {
		const files = [
			path.join(SRC_DIR, "bracketed-paste.ts"),
			path.join(SRC_DIR, "stdin-buffer.ts"),
			path.join(CODING_AGENT_SRC, "modes/components/custom-editor.ts"),
			path.join(CODING_AGENT_SRC, "modes/components/custom-editor.test.ts"),
		];
		const texts = await Promise.all(files.map(file => Bun.file(file).text()));
		const joined = texts.join("\n");
		expect(joined.split('"\\x1b[200~"')).toHaveLength(2);
		expect(joined.split('"\\x1b[201~"')).toHaveLength(2);
		const owner = texts[0] as string;
		expect(owner).toContain('export const PASTE_START = "\\x1b[200~";');
		expect(owner).toContain('export const PASTE_END = "\\x1b[201~";');
	});

	/**
	 * The positive half: each former declarer imports the markers now. A module that reintroduced them under
	 * a different spelling would pass the count above and fail here.
	 */
	it("has every former declarer importing the owner's markers", async () => {
		const stdinBuffer = await Bun.file(path.join(SRC_DIR, "stdin-buffer.ts")).text();
		expect(stdinBuffer).toMatch(/import \{[^}]*PASTE_START[^}]*\} from "\.\/bracketed-paste";/);
		expect(stdinBuffer).not.toContain("const PASTE_START");
		expect(stdinBuffer).not.toContain("BRACKETED_PASTE_START");

		for (const file of ["modes/components/custom-editor.ts", "modes/components/custom-editor.test.ts"]) {
			const text = await Bun.file(path.join(CODING_AGENT_SRC, file)).text();
			expect(text).toMatch(/import \{[^}]*PASTE_START[^}]*\} from "@veyyon\/tui\/bracketed-paste";/);
			expect(text).not.toContain("BRACKETED_PASTE_START");
		}
	});

	/**
	 * The non-vacuity twin for the scan above: if a path stopped resolving, `Bun.file().text()` would reject
	 * rather than pass, but a file that had merely moved would leave the count trivially satisfied. This
	 * proves each scanned file is the module it is supposed to be.
	 */
	it("scans the four modules the copies actually lived in", async () => {
		const expected: Array<[string, string]> = [
			[path.join(SRC_DIR, "bracketed-paste.ts"), "class BracketedPasteHandler"],
			[path.join(SRC_DIR, "stdin-buffer.ts"), "class StdinBuffer"],
			[path.join(CODING_AGENT_SRC, "modes/components/custom-editor.ts"), "extractExplicitPathSegments"],
			[path.join(CODING_AGENT_SRC, "modes/components/custom-editor.test.ts"), "describe("],
		];
		for (const [file, marker] of expected) {
			expect(await Bun.file(file).text()).toContain(marker);
		}
	});
});
