/**
 * ONE-PLACE lock for the option labels the ask runtime adds to a question.
 *
 * Why this suite exists: these three strings are compared by STRING EQUALITY to decide behaviour, and they were
 * declared in three modules under two sets of names. `tools/ask.ts` had `OTHER_OPTION`,
 * `CHAT_ABOUT_THIS_OPTION` and `NEXT_OPTION`; `modes/controllers/extension-ui-controller.ts` had
 * `ASK_OTHER_OPTION`, `ASK_CHAT_OPTION` and `ASK_NEXT_OPTION` with identical values;
 * `modes/components/ask-dialog.ts` held a third copy of the first one because it draws the row.
 *
 * A drift between the module that RENDERS a label and the module that COMPARES it does not fail loudly. The
 * comparison returns false, the branch never runs, and the label itself is handed back to the model as though
 * the user had typed it. So a user who picks "Other (type your own)" to answer in their own words gets no
 * prompt, and the model is told their answer was the words "Other (type your own)".
 *
 * The reserved-label contract made the split sharper rather than harmless: `tools/ask.ts` REJECTS a question
 * whose own options collide with one of these labels, so the validator and the renderer had to agree about the
 * same three strings while reading two different declarations of them. Two of ask.ts's three copies existed
 * only to populate that record, while the module that actually renders and compares them is the controller.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	ASK_CHAT_OPTION_LABEL,
	ASK_NEXT_OPTION_LABEL,
	ASK_OTHER_OPTION_LABEL,
	isReservedAskOptionLabel,
	RESERVED_ASK_OPTION_LABELS,
} from "@veyyon/coding-agent/tools/ask-option-labels";
import { moduleSpecifiersIn } from "@veyyon/utils/module-reach";
import { RECOMMENDED_SUFFIX, stripRecommendedSuffix, withRecommendedSuffix } from "@veyyon/wire";

const SRC = path.resolve(import.meta.dir, "../../src");
const OWNER_REL = "tools/ask-option-labels.ts";

/** The modules that used to declare a label and must now import it. */
const FORMER_DECLARERS: readonly string[] = [
	"tools/ask.ts",
	"modes/components/ask-dialog.ts",
	"modes/controllers/extension-ui-controller.ts",
];

const RETIRED_NAMES: readonly string[] = [
	"OTHER_OPTION",
	"CHAT_ABOUT_THIS_OPTION",
	"NEXT_OPTION",
	"ASK_OTHER_OPTION",
	"ASK_CHAT_OPTION",
	"ASK_NEXT_OPTION",
	"RESERVED_OPTION_LABELS",
];

async function sources(): Promise<ReadonlyArray<{ file: string; text: string }>> {
	const files = [...new Bun.Glob("**/*.ts").scanSync(SRC)]
		.map(file => file.split(path.sep).join("/"))
		.filter(file => file !== OWNER_REL)
		.sort();
	return await Promise.all(files.map(async file => ({ file, text: await Bun.file(path.join(SRC, file)).text() })));
}

describe("the reserved ask option labels", () => {
	/**
	 * The exact label for the free-text escape hatch. Pinned as bytes because the prompt in
	 * `prompts/tools/ask.md` states it verbatim to stop the model adding an "Other" option of its own, so a
	 * change here without the same change there gives the user two.
	 */
	it("labels the free-text option", () => {
		expect(ASK_OTHER_OPTION_LABEL).toBe("Other (type your own)");
	});

	/** The label that abandons the question and returns to the conversation. */
	it("labels the leave-the-question option", () => {
		expect(ASK_CHAT_OPTION_LABEL).toBe("Chat about this");
	});

	/**
	 * The label that advances a multi-question ask, arrow included. The arrow is part of the compared bytes, so
	 * a hand-written ASCII `->` somewhere would look nearly identical in a terminal and never match.
	 */
	it("labels the next-question option with a real arrow", () => {
		expect(ASK_NEXT_OPTION_LABEL).toBe("Next →");
		expect(ASK_NEXT_OPTION_LABEL).toContain("→");
		expect(ASK_NEXT_OPTION_LABEL).not.toContain("->");
	});

	/** All three are reserved, in the order a reader should think about them: answer differently, leave, move on. */
	it("reserves exactly these three labels", () => {
		expect([...RESERVED_ASK_OPTION_LABELS]).toEqual(["Other (type your own)", "Chat about this", "Next →"]);
	});

	/** The predicate accepts every reserved label. */
	it("recognises every reserved label", () => {
		for (const label of RESERVED_ASK_OPTION_LABELS) {
			expect(isReservedAskOptionLabel(label), label).toBeTrue();
		}
	});

	/**
	 * And nothing else, including the near misses a caller would plausibly write. Case and whitespace matter
	 * because the picker returns the rendered label and the comparison is exact.
	 */
	it("treats near misses as ordinary labels", () => {
		for (const label of [
			"Other",
			"other (type your own)",
			"Other (type your own) ",
			" Other (type your own)",
			"Chat",
			"Next",
			"Next ->",
			"",
		]) {
			expect(isReservedAskOptionLabel(label), label).toBeFalse();
		}
	});

	/**
	 * A reserved label is distinct from the others, so no single selection can satisfy two branches. Worth
	 * asserting because the branches are checked in sequence and an accidental duplicate would make the later
	 * checks dead.
	 */
	it("keeps the three labels distinct", () => {
		expect(new Set(RESERVED_ASK_OPTION_LABELS).size).toBe(3);
	});

	/** Each label is non-empty and free of surrounding whitespace, since it is both drawn and compared as-is. */
	it("holds trimmed, non-empty labels", () => {
		for (const label of RESERVED_ASK_OPTION_LABELS) {
			expect(label, label).toBe(label.trim());
			expect(label.length, label).toBeGreaterThan(0);
		}
	});
});

describe("the ask option labels have one owner", () => {
	/**
	 * The ratchet, keyed on the LITERAL rather than on the retired names, because both prior copies used names
	 * of their own and a third copy would too.
	 */
	it("declares no reserved label outside the owner", async () => {
		const offenders: string[] = [];
		for (const { file, text } of await sources()) {
			for (const label of RESERVED_ASK_OPTION_LABELS) {
				if (new RegExp(`^\\s*(?:export )?const \\w+ = "${label}";`, "m").test(text)) {
					offenders.push(`${file} declares ${label}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	/** Nor under one of the names the copies used, whatever value it were given. */
	it("declares none of the retired names", async () => {
		const offenders: string[] = [];
		for (const { file, text } of await sources()) {
			for (const name of RETIRED_NAMES) {
				if (new RegExp(`^\\s*(?:export )?const ${name}\\b`, "m").test(text)) offenders.push(`${file}: ${name}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	/**
	 * The non-vacuity twin. Both ratchets would pass over an empty scan, so require that it reaches the whole
	 * package and every module that held a copy.
	 */
	it("scans the package including all three former declarers", async () => {
		const files = (await sources()).map(entry => entry.file);
		expect(files.length).toBeGreaterThan(200);
		for (const declarer of FORMER_DECLARERS) {
			expect(files).toContain(declarer);
		}
	});

	/** The positive half: each former declarer takes its labels from the owner. */
	it("has every former declarer importing from the owner", async () => {
		for (const declarer of FORMER_DECLARERS) {
			const text = await Bun.file(path.join(SRC, declarer)).text();
			expect(text, declarer).toMatch(/from "(?:\.\.\/\.\.\/tools\/ask-option-labels|\.\/ask-option-labels)";/);
		}
	});

	/**
	 * The validator and the renderers now read one declaration. Asserted structurally because the consequence is
	 * invisible at runtime: `tools/ask.ts` rejects a question whose options collide with a reserved label, and
	 * while that check read its own copy it could have been rejecting a string no UI ever rendered.
	 */
	it("has the question validator using the shared predicate", async () => {
		const ask = await Bun.file(path.join(SRC, "tools/ask.ts")).text();
		expect(ask).toContain("isReservedAskOptionLabel(option.label)");
		expect(ask).not.toContain("RESERVED_OPTION_LABELS[option.label]");
	});

	/**
	 * The prompt is the one consumer that cannot import a constant, because it is text the model reads. So the
	 * coupling is asserted from the constant's side: if the label changes, this fails and names the file that
	 * has to change with it.
	 */
	it("has the ask prompt teaching the same free-text label", async () => {
		const prompt = await Bun.file(path.join(SRC, "prompts/tools/ask.md")).text();
		expect(prompt).toContain(ASK_OTHER_OPTION_LABEL);
	});

	/**
	 * The owner is a leaf. The dialog and the controller are UI modules, and reaching `tools/ask.ts` for a label
	 * would have meant importing the whole ask flow, its arktype schema and its renderers, to read a string.
	 * That cost is exactly why the labels were retyped, so an import here brings the pressure back.
	 */
	it("imports nothing", async () => {
		const owner = await Bun.file(path.join(SRC, OWNER_REL)).text();
		// The PARSED specifier list, not the characters: the scan this replaced also went red on a doc
		// comment containing `from "..."`, and on a free `import type`, which costs nothing at runtime.
		expect(moduleSpecifiersIn(owner)).toEqual([]);
	});
});


/**
 * The fourth label, and the only one that leaves this package.
 *
 * ` (Recommended)` is not a reserved label: the runtime does not add a row for it, it EDITS the label of a row
 * the caller supplied, and then compares the edited text back. That makes the writer/reader split worse than
 * the three above rather than milder. `tools/ask.ts` appended it and stripped it; `modes/components/ask-dialog.ts`
 * appended it a SECOND time from a bare template literal (`${label} (Recommended)`) and stripped it with a
 * private copy of the string; `@veyyon/tool-render` stripped it with a third copy when rendering an answer for
 * HTML export and collab. Four spellings, two of them writers.
 *
 * The failure is silent and lands in the model's context. Change the wording in one writer and the readers stop
 * matching, so the marker survives into the answer and the model is told the user chose
 * "Deploy to production (Recommended)" rather than "Deploy to production". Nothing throws.
 *
 * The owner is `@veyyon/wire` rather than `tools/ask-option-labels.ts` because tool-render has to read it and
 * cannot import from coding-agent. wire is dependency-free and both packages already depend on it.
 */
describe("the recommended-option marker", () => {
	/** Pinned as bytes: the leading space is part of the marker, and a label is compared exactly. */
	it("is a space-prefixed parenthesised word", () => {
		expect(RECOMMENDED_SUFFIX).toBe(" (Recommended)");
	});

	/** The round trip the whole design rests on: what the writer adds, the reader takes back off. */
	it("strips back to the label the caller supplied", () => {
		for (const label of ["Deploy to production", "JWT", "Other (type your own)", "Next →", "a (Recommended) b"]) {
			expect(stripRecommendedSuffix(withRecommendedSuffix(label))).toBe(label);
		}
	});

	/** Marking twice marks once, which is what stops a re-render from producing "X (Recommended) (Recommended)". */
	it("is idempotent when applied again", () => {
		const once = withRecommendedSuffix("Deploy");
		expect(withRecommendedSuffix(once)).toBe(once);
		expect(once).toBe("Deploy (Recommended)");
	});

	/** A label that never carried the marker is returned untouched, including the near misses. */
	it("leaves an unmarked label alone", () => {
		for (const label of ["Deploy", "(Recommended)", "Deploy (recommended)", "Deploy (Recommended) ", ""]) {
			expect(stripRecommendedSuffix(label), label).toBe(label);
		}
	});

	/** Only a TRAILING marker is removed, so a label that mentions the word mid-string keeps it. */
	it("removes only a trailing marker", () => {
		expect(stripRecommendedSuffix("A (Recommended) then B")).toBe("A (Recommended) then B");
	});
});

describe("the recommended-option marker has one owner", () => {
	const MARKER_DECL = /^\s*(?:export )?const \w+ = " \(Recommended\)";/m;
	/** Appending the marker by hand instead of calling the helper, which is what ask-dialog.ts did. */
	const HAND_APPEND = /`\$\{[^}]+\} \(Recommended\)`/;

	/** The former declarers, one of them in another package. */
	const MARKER_READERS: readonly string[] = ["tools/ask.ts", "modes/components/ask-dialog.ts"];

	it("declares the marker nowhere in coding-agent", async () => {
		const offenders = (await sources())
			.filter(({ text }) => MARKER_DECL.test(text))
			.map(({ file }) => file);
		expect(offenders).toEqual([]);
	});

	/** Nor builds it inline, which no constant-name ratchet would have caught. */
	it("appends the marker through the helper, never a template literal", async () => {
		const offenders = (await sources())
			.filter(({ text }) => HAND_APPEND.test(text))
			.map(({ file }) => file);
		expect(offenders).toEqual([]);
	});

	/** The positive half: both readers take it from wire. */
	it("has both coding-agent readers importing from @veyyon/wire", async () => {
		for (const reader of MARKER_READERS) {
			const text = await Bun.file(path.join(SRC, reader)).text();
			expect(moduleSpecifiersIn(text), reader).toContain("@veyyon/wire");
			expect(text, reader).toContain("RecommendedSuffix");
		}
	});

	/**
	 * The cross-package half. tool-render is a separate package that renders the answer for HTML export and
	 * collab, so its copy could drift without anything in coding-agent noticing.
	 */
	it("has tool-render reading the marker from wire rather than its own copy", async () => {
		const rel = "../../../tool-render/src/tools/ask.tsx";
		const text = await Bun.file(path.resolve(import.meta.dir, rel)).text();
		expect(MARKER_DECL.test(text)).toBe(false);
		expect(moduleSpecifiersIn(text)).toContain("@veyyon/wire");
	});

	/**
	 * The prompt states the marker verbatim so the model knows not to write it into a label itself. Same
	 * coupling as the free-text label above, asserted from the constant's side.
	 */
	it("has the ask prompt teaching the same marker", async () => {
		const prompt = await Bun.file(path.join(SRC, "prompts/tools/ask.md")).text();
		expect(prompt).toContain(RECOMMENDED_SUFFIX);
	});
});
