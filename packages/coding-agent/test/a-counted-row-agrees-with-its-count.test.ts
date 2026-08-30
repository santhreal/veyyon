/**
 * WHY THIS SUITE EXISTS.
 *
 * A counted row has more than a noun in it. `pluralize` and `formatCount` owned
 * the noun, and every word around it was spelled by hand at twenty-five sites in
 * six fused dialects: a bare `n === 1 ? "is" : "are"`, the verb fused to the
 * noun (`"phase is" : "phases are"`), the verb fused to the count
 * (`"1 account has"` in one arm against a template holding the other number),
 * the verb fused to the noun's suffix (`record` plus `" was"` or `"s were"`), a
 * capitalised sentence opener, and a boolean subject spelled `many` or `one`.
 *
 * Six rows agreed with nothing at all, because the count that reached them was
 * new: `/secret audit` said `1 line … are not shown above`, `/cpu` said `1 core
 * are bounded by it`, the image notice said `These 1 images are`, `/account`
 * said `1 account have`, the todo tool said `all 1 phase are closed`, and the
 * write tool said `1 stray marker are not \`<id>: @side\` directives`.
 *
 * THE CLASS. Every word in a counted row that changes with the number goes
 * through one owner, `agreeWith` in `@veyyon/utils/format`, and the pair IS the
 * specification: `agreeWith("is/are", n)` splits its own key, so there is no
 * lookup table to keep in step with the union and a call site shows both words
 * it can emit.
 *
 * TWO SWEEPS, because the defect has two shapes.
 *
 * Arm A finds a hand-rolled agreement ternary — two quoted arms that differ by
 * a known pair — anywhere in the product source, and needs no exemptions: every
 * such site now routes through the owner, including the ones whose text is
 * written for the model rather than drawn on a row.
 *
 * Arm B finds the shape a ternary sweep cannot see: a row that interpolates an
 * OWNED count and then hardcodes the word next to it. It reads the three words
 * following each `formatCount` / `formatMore` / `formatMoreLines` / `pluralize`
 * substitution, which is where every one of the six broken rows carried its
 * wrong word. The two classes compose — the noun class forces a count through
 * `formatCount`, and this arm then reads it.
 *
 * WHAT IT DOES NOT CATCH, named rather than implied.
 *
 * Agreement is not always with the count, and no sweep can decide which noun a
 * verb belongs to. `anything stored in them is missing` keeps `is`, because the
 * grammatical subject is "anything"; `dropped 3 lines that duplicated the code`
 * keeps `that`, because a relative pronoun does not agree with number at all.
 * Every one of those is named in {@link EXEMPT} with the subject it agrees with,
 * so a new hardcoded word beside a count is red rather than absorbed.
 *
 * A count interpolated raw — `${this.#selected.size} selected` — is out of Arm
 * B's reach, because the arm keys off the owner's name. The noun class is what
 * pushes a count through `formatCount` in the first place.
 *
 * An agreement word BEFORE the count is not swept. Every site in the tree today
 * has a plural noun as its own subject (`Over-budget commands are …`), so a
 * window on that side would flag correct rows and teach a reader to skim the
 * table.
 *
 * Irregular and compound nouns stay with the noun class, and a row that agrees
 * correctly while saying the wrong thing is nobody's sweep.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { renderSecretList } from "@veyyon/coding-agent/secrets/secret-command";
import { imageVisibilityNotice } from "@veyyon/coding-agent/session/image-visibility";
import { foldToolOutputBookkeeping } from "@veyyon/coding-agent/tools/output-fold";
import { AGREEMENT_PAIRS, agreeWith } from "@veyyon/utils/format";
import { HOLE, scanSource, sources } from "./helpers/source-literals";

const PACKAGES = path.resolve(import.meta.dir, "../..");

/**
 * Every product tree that writes a counted row: the CLI, the React tool views
 * behind the HTML export and the collab guest, the guest client, the terminal
 * library and the shared formatters that own the words.
 */
const ROOTS = ["coding-agent/src", "tool-render/src", "collab-web/src", "tui/src", "utils/src"].map(relative =>
	path.resolve(PACKAGES, relative),
);

/**
 * A ternary whose two arms are quoted text. Both quote styles and the template
 * literal are accepted, because the fused dialects used all three.
 */
const TERNARY_ARMS = /\?\s*(["'`])([^"'`\n]*)\1\s*:\s*(["'`])([^"'`\n]*)\3/g;

/** A substitution that carries a count the noun class already owns. */
const OWNED_COUNT = /\b(?:formatCount|formatMore|formatMoreLines|pluralize)\s*\(/;

/** Longest arm a sweep reads as agreement rather than as prose. */
const MAX_ARM_WORDS = 4;

/** Words after an owned count that Arm B reads. Every broken row put it in the first. */
const WINDOW_WORDS = 3;

/**
 * A hardcoded agreement word beside an owned count that agrees with something
 * else, keyed by file, with the exact literal pinned and the real subject named.
 *
 * Keyed by string as well as by file because `session/cpu-limit.ts` and
 * `tools/write.ts` each carry two, and a whole-file waiver would excuse the next
 * offender in the surfaces most likely to grow one.
 */
const EXEMPT: Record<string, { why: string; strings: readonly string[] }> = {
	"coding-agent/src/config/model-resolution-failure.ts": {
		why: "`has` agrees with `none`, which is singular whatever the registry holds.",
		strings: [`No models are available: the registry knows ${HOLE} but none has `],
	},
	"coding-agent/src/hindsight/state.ts": {
		why: "`that batch` is the one failed batch, not the memories counted before it.",
		strings: [`Memory retention failed for ${HOLE}; that batch was not retained. Retry the retain tool.`],
	},
	"coding-agent/src/prompts/eval-overrides.ts": {
		why: "`this build does not have` agrees with the build, of which there is one.",
		strings: [`VEYYON_EVAL_PROMPTS names ${HOLE} this build does not have:\n`],
	},
	"coding-agent/src/session/cpu-limit.ts": {
		why: "The subjects are the session's one budget and one setting, not the cores or commands counted beside them.",
		strings: [
			`Refused to start ${HOLE}: this session's CPU budget of ${HOLE} is saturated `,
			`${HOLE}. Sent SIGTERM to ${HOLE} because session.writeBudgetKill is on. `,
		],
	},
	"coding-agent/src/session/shake-types.ts": {
		why: "`this session` is the session, not the entries dropped from it.",
		strings: [`Dropped ${HOLE} from this session.`],
	},
	"coding-agent/src/session/verification-evidence-ledger.ts": {
		why: "`these` points at the rows already listed above, not at the number beyond them.",
		strings: [`… and ${HOLE} beyond these.`],
	},
	"coding-agent/src/system-prompt.ts": {
		why: "`This is NOT the production prompt` names the prompt; the counts before it are the sections replaced in it.",
		strings: [
			`replacing ${HOLE} [${HOLE}]. This is NOT the production prompt — expected only inside a benchmark arm.`,
		],
	},
	"coding-agent/src/tools/output-fold.ts": {
		why: "`failures are never folded` has `failures` as its subject, which is plural at every count of folded lines.",
		strings: [`[folded ${HOLE} ${HOLE} ${HOLE}; failures are never folded]`],
	},
	"coding-agent/src/tools/write.ts": {
		why: "`that` is a relative pronoun introducing what the dropped lines did, and English does not inflect it for number.",
		strings: [
			`\nNote: dropped ${HOLE} that duplicated the code adjacent to the conflict region — writes replace only the marker block; surrounding lines stay in place.`,
			`Note: dropped ${HOLE} that duplicated code adjacent to conflict regions — writes replace only the marker block; surrounding lines stay in place.`,
		],
	},
};

/** `singular` and `plural` for one pair, split the way the owner splits it. */
function halves(pair: string): { one: string; many: string } {
	const slash = pair.indexOf("/");
	return { one: pair.slice(0, slash), many: pair.slice(slash + 1) };
}

/** Whether `text` uses `word` as a whole word, in either case. */
function says(text: string, word: string): boolean {
	return new RegExp(`(^|[^\\w])${word}([^\\w]|$)`, "i").test(text);
}

function wordCount(text: string): number {
	return text.trim().split(/\s+/).filter(Boolean).length;
}

/** `<file>` relative to `packages/`, in the spelling {@link EXEMPT} uses. */
function key(file: string): string {
	return path.relative(PACKAGES, file).split(path.sep).join("/");
}

/** Every source file the sweeps read, across every product root. */
function productSources(): string[] {
	return ROOTS.flatMap(root => sources(root));
}

/** `<file>:<line>: <ternary>` for every hand-rolled agreement ternary. */
function handRolled(): string[] {
	const found: string[] = [];
	for (const file of productSources()) {
		const { code } = scanSource(fs.readFileSync(file, "utf8"));
		for (const match of code.matchAll(TERNARY_ARMS)) {
			const left = match[2] ?? "";
			const right = match[4] ?? "";
			if (wordCount(left) > MAX_ARM_WORDS || wordCount(right) > MAX_ARM_WORDS) continue;
			const agreeing = AGREEMENT_PAIRS.some(pair => {
				const { one, many } = halves(pair);
				return (says(left, one) && says(right, many)) || (says(left, many) && says(right, one));
			});
			if (!agreeing) continue;
			const line = code.slice(0, match.index).split("\n").length;
			found.push(`${key(file)}:${line}: ${JSON.stringify(match[0])}`);
		}
	}
	return found;
}

/** `<file>` → the literals hardcoding an agreement word right after an owned count. */
function besideAnOwnedCount(): Map<string, string[]> {
	const hits = new Map<string, string[]>();
	for (const file of productSources()) {
		const { literals } = scanSource(fs.readFileSync(file, "utf8"));
		for (const { body, holes } of literals) {
			let at = -1;
			for (const hole of holes) {
				at = body.indexOf(HOLE, at + 1);
				if (!OWNED_COUNT.test(hole)) continue;
				const window = body
					.slice(at + 1)
					.split(/\s+/)
					.filter(Boolean)
					.slice(0, WINDOW_WORDS)
					.join(" ");
				const hardcoded = AGREEMENT_PAIRS.some(pair => {
					const { one, many } = halves(pair);
					return says(window, one) || says(window, many);
				});
				if (!hardcoded) continue;
				const bucket = hits.get(key(file)) ?? [];
				if (!bucket.includes(body)) bucket.push(body);
				hits.set(key(file), bucket);
			}
		}
	}
	return hits;
}

describe("the owner of an agreement word", () => {
	/**
	 * The contract, over every pair the union declares rather than over a list
	 * written here: a pair added without a decision about zero is red.
	 */
	it("picks the singular at one and the plural at every other count", () => {
		const wrong: string[] = [];
		for (const pair of AGREEMENT_PAIRS) {
			const { one, many } = halves(pair);
			if (agreeWith(pair, 1) !== one) wrong.push(`${pair} at 1 → ${agreeWith(pair, 1)}`);
			for (const count of [0, 2, 7, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
				if (agreeWith(pair, count) !== many) wrong.push(`${pair} at ${count} → ${agreeWith(pair, count)}`);
			}
		}
		expect(wrong).toEqual([]);
	});

	/** The pair is the specification, so a malformed one is a row that emits a slash. */
	it("declares every pair as two distinct words", () => {
		const malformed = AGREEMENT_PAIRS.filter(pair => {
			const { one, many } = halves(pair);
			return (
				pair.split("/").length !== 2 ||
				one === "" ||
				many === "" ||
				one === many ||
				/\s/.test(pair) ||
				pair !== pair.trim()
			);
		});
		expect(malformed).toEqual([]);
		expect([...new Set(AGREEMENT_PAIRS)]).toHaveLength(AGREEMENT_PAIRS.length);
		expect(AGREEMENT_PAIRS.some(pair => agreeWith(pair, 1).includes("/"))).toBe(false);
	});
});

describe("the product source", () => {
	/** Arm A. No exemption table: every site routes through the owner. */
	it("spells no agreement by hand", () => {
		expect(handRolled()).toEqual([]);
	});

	/** Arm B. What is left is named, with the subject each word really agrees with. */
	it("hardcodes no word beside a count the noun owner already formatted", () => {
		const offenders: string[] = [];
		for (const [file, bodies] of besideAnOwnedCount()) {
			const allowed = EXEMPT[file]?.strings ?? [];
			for (const body of bodies) if (!allowed.includes(body)) offenders.push(`${file}: ${JSON.stringify(body)}`);
		}
		expect(offenders).toEqual([]);
	});

	/**
	 * Pinned in the other direction too: a row that is fixed, moved or reworded
	 * leaves a waiver behind that would silently excuse the next offender in the
	 * same file.
	 */
	it("carries no exemption the sweep no longer finds", () => {
		const found = besideAnOwnedCount();
		const stale: string[] = [];
		for (const [file, { strings }] of Object.entries(EXEMPT)) {
			const bodies = found.get(file) ?? [];
			for (const body of strings) if (!bodies.includes(body)) stale.push(`${file}: ${JSON.stringify(body)}`);
		}
		expect(stale).toEqual([]);
	});

	/** Every waiver says which subject the word agrees with instead. */
	it("gives every exemption a reason", () => {
		const unexplained = Object.entries(EXEMPT).filter(([, entry]) => entry.why.trim().length < 20);
		expect(unexplained).toEqual([]);
	});
});

describe("the rows that agreed with nothing", () => {
	/** `These 1 images are` was the reported wording. */
	it("states an image's visibility in the number of images there are", () => {
		const one = imageVisibilityNotice({ shown: false, reason: "images-off" }, 1) ?? "";
		const many = imageVisibilityNotice({ shown: false, reason: "images-off" }, 3) ?? "";
		const some = imageVisibilityNotice({ shown: false, reason: "images-off", undrawnCount: 1 }, 3) ?? "";
		expect(one).toStartWith("This image is in your context only:");
		expect(many).toStartWith("These 3 images are in your context only:");
		expect(some).toStartWith("1 of these 3 images is in your context only:");
	});

	/**
	 * The fold row's own count, which is per class: a run whose second class
	 * folded one line is the only way to reach the singular, and it used to read
	 * `1 passing package results lines`.
	 */
	it("counts folded lines in the singular when one line folded", () => {
		const text = [...Array.from({ length: 12 }, (_, i) => `=== RUN TestOne${i}`), "ok example/pkg 0.01s"].join("\n");
		const folded = foldToolOutputBookkeeping(text).text;
		expect(folded).toContain("1 passing package results line;");
		expect(folded).not.toContain("1 passing package results lines");
		expect(folded).toContain("12 === RUN/CONT/PAUSE lines;");
	});

	/** `/secret list`'s masked footer: the verb and the pronoun both move. */
	it("reports masked values with a verb and a pronoun that match the count", () => {
		const one = renderSecretList([], { now: 1_700_000_000_000, masked: { count: 1, unlabelled: 1, sources: [] } });
		const many = renderSecretList([], { now: 1_700_000_000_000, masked: { count: 4, unlabelled: 2, sources: [] } });
		expect(one).toContain("1 value masked in what is sent");
		expect(one).toContain("cannot spend it:");
		expect(one).toContain("1 value was declared without a source");
		expect(many).toContain("4 values masked in what is sent");
		expect(many).toContain("cannot spend them:");
		expect(many).toContain("2 values were declared without a source");
	});

	/** The unreadable-scope repair notice: four words move together with the noun. */
	it("describes unreadable vaults in the number of vaults it could not read", () => {
		const one = renderSecretList([], { now: 1_700_000_000_000, unreadable: ["project"] });
		const two = renderSecretList([], { now: 1_700_000_000_000, unreadable: ["project", "profile"] });
		expect(one).toContain("vault could not be read, so anything stored in it is missing");
		expect(one).toContain("The vault is encrypted");
		expect(one).toContain("re-add the secrets it held");
		expect(two).toContain("vaults could not be read, so anything stored in them is missing");
		expect(two).toContain("The vaults are encrypted");
		expect(two).toContain("re-add the secrets they held");
	});
});
