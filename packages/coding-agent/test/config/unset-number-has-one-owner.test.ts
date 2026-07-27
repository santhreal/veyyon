/**
 * `-1` means "unset" in exactly one module, and every other file asks that module.
 *
 * WHY THIS SUITE EXISTS. Seven numeric settings encoded "let the provider decide" as `-1`,
 * and the encoding was written out by hand at every site. That cost two real bugs rather
 * than tidiness:
 *
 *  - `sdk.ts` read every sampling knob as `value >= 0 ? value : undefined`, so a legitimately
 *    negative `presencePenalty` or `repetitionPenalty` (both range -2..2 at the providers)
 *    was discarded along with the sentinel. Setting a negative penalty did nothing, silently.
 *  - The same `>= 0` test was then written out SIX more times in the settings selector's
 *    side-effect switch, one case per knob, so fixing `sdk.ts` left the interactive path
 *    still broken. Six copies is why the fix looked complete and was not.
 *
 * Unset is now the ABSENT key: `config/optional-number.ts` owns the name `UNSET_NUMBER`, the
 * submenu row, and the `optionalNumber` read, and `config/settings.ts` imports that name to
 * drop a legacy `-1` as it loads. No code re-derives unset from the number any more, and this
 * suite is the lock, because the failure mode of the old design was a SEVENTH copy appearing
 * in a file nobody thought to check.
 *
 * The scan is deliberately narrow: a line has to name one of the schema-derived optional
 * numeric settings AND compare against -1 in the same breath. `-1` is everywhere in a
 * codebase as `indexOf`'s miss and as other people's protocol sentinels (llama.cpp's
 * `n_predict: -1` for unlimited is a real one in `config/model-discovery.ts`), and a check
 * that flagged those would be turned off within a week.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { UNSET_NUMBER } from "@veyyon/coding-agent/config/optional-number";
import { isUnsetNumberPath } from "@veyyon/coding-agent/config/settings-schema";
import { getAllSettingDefs } from "@veyyon/coding-agent/modes/components/settings-defs";

const SRC_ROOT = path.resolve(import.meta.dir, "../../src");

/**
 * The files allowed to spell the legacy sentinel, relative to `src/`.
 *
 * `optional-number.ts` declares it and translates it. `settings.ts` is the load migration
 * that removes it from a config an older version wrote, which is the only reason the name
 * still exists at all.
 */
const OWNERS = ["config/optional-number.ts", "config/settings.ts"];

/** The optional numeric settings, taken from the schema rather than a list kept here. */
function optionalNumericLeaves(): string[] {
	const leaves = getAllSettingDefs()
		.filter(def => isUnsetNumberPath(def.path))
		.map(def => def.path.split(".").at(-1) ?? def.path);
	return [...new Set(leaves)].sort();
}

/** Every `.ts` under `src/`, with its text, as `{ file, text }` relative to `src/`. */
async function sources(): Promise<Array<{ file: string; text: string }>> {
	const glob = new Bun.Glob("**/*.ts");
	const files: string[] = [];
	for await (const relative of glob.scan({ cwd: SRC_ROOT, onlyFiles: true })) {
		files.push(relative.replace(/\\/g, "/"));
	}
	return await Promise.all(
		files.map(async file => ({ file, text: await Bun.file(path.join(SRC_ROOT, file)).text() })),
	);
}

const SOURCES = sources();

/**
 * Lines that both name one of `leaves` and compare against `-1`.
 *
 * Comment lines are excluded: `optional-number.ts`'s own header explains the old spellings
 * on purpose, and so does the doc comment of anything that had to be migrated. A comment
 * cannot re-derive unset; only code can.
 */
function sentinelComparisons(
	files: ReadonlyArray<{ file: string; text: string }>,
	leaves: readonly string[],
): Array<{ file: string; line: number; text: string }> {
	const namesAKnob = new RegExp(`\\b(?:${leaves.join("|")})\\b`);
	const comparesToSentinel = /(?:===?|!==?|<|<=|>|>=)\s*-1\b|-1\s*(?:===?|!==?|<|<=|>|>=)/;
	const hits: Array<{ file: string; line: number; text: string }> = [];
	for (const { file, text } of files) {
		text.split("\n").forEach((line, index) => {
			const code = line.trim();
			if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
			if (!namesAKnob.test(code) || !comparesToSentinel.test(code)) return;
			hits.push({ file, line: index + 1, text: code });
		});
	}
	return hits;
}

describe("the unset-number sentinel", () => {
	it("reads the sources and the schema the rest of these checks depend on", async () => {
		// Stated separately so a scan that found nothing, or a schema query that returned an
		// empty set, cannot make the assertions below pass by having nothing to look at.
		const files = await SOURCES;

		expect(files.length).toBeGreaterThan(500);
		expect(files.some(({ file }) => file === "config/optional-number.ts")).toBe(true);
		expect(optionalNumericLeaves()).toEqual([
			"minP",
			"modelContextWindow",
			"presencePenalty",
			"repetitionPenalty",
			"temperature",
			"topK",
			"topP",
		]);
	});

	/**
	 * THE LOCK. A file comparing a sampling knob against -1 is re-deriving unset, which is
	 * how the negative-penalty bug survived its own fix in six more places.
	 */
	it("is compared against in no file except its owners", async () => {
		const hits = sentinelComparisons(await SOURCES, optionalNumericLeaves());

		// Listed rather than counted, so a failure names the file and line that re-derived it.
		expect(hits.filter(hit => !OWNERS.includes(hit.file))).toEqual([]);
	});

	/**
	 * The anti-vacuity half, and it is not optional: the lock above currently finds NOTHING,
	 * which is the desired state and also indistinguishable from a detector that stopped
	 * working. So the detector is run against the code as it actually used to be written --
	 * the `sdk.ts` read and one of the six selector cases, verbatim in shape -- and it has to
	 * catch both. If a future edit breaks the regex pair, this fails while the lock stays
	 * quietly green, which is the only ordering that keeps the lock meaningful.
	 */
	it("catches the exact re-derivations this rule exists to prevent", () => {
		const asItWasWritten = [
			{
				file: "sdk.ts",
				text: "const temperature = agent.temperature >= -1 ? agent.temperature : undefined;",
			},
			{
				file: "modes/components/selector-controller.ts",
				text: 'case "presencePenalty":\n\tagent.presencePenalty = value === -1 ? undefined : value;',
			},
		];

		const hits = sentinelComparisons(asItWasWritten, optionalNumericLeaves());

		expect(hits.map(hit => hit.file)).toEqual(["sdk.ts", "modes/components/selector-controller.ts"]);
		expect(hits[1]?.text).toContain("presencePenalty = value === -1");
	});

	/**
	 * A comment may describe the old encoding, because the owner's header and the migration's
	 * doc comment both do -- explaining what was wrong is how the rule survives. Only code
	 * counts, so the exclusion is asserted rather than assumed.
	 */
	it("reads a comment about the old encoding as prose, not as a re-derivation", () => {
		const documented = [
			{ file: "config/whatever.ts", text: "// temperature used to be -1 when unset; it is an absent key now" },
			{ file: "config/other.ts", text: " * `presencePenalty === -1` was unreachable while -1 meant unset." },
		];

		expect(sentinelComparisons(documented, optionalNumericLeaves())).toEqual([]);
	});

	/**
	 * One name for one number. `config/settings.ts` declared its own `LEGACY_UNSET_SENTINEL = -1`
	 * beside the owner's `UNSET_NUMBER`, which is two spellings of one encoding in the two files
	 * most likely to disagree about it: the module that translates the sentinel and the module
	 * that deletes it. It now imports the owner's. This asserts no third one appears.
	 */
	it("is declared under exactly one name", async () => {
		const declaration = /^\s*(?:export\s+)?const\s+(\w*(?:UNSET|SENTINEL)\w*)\s*(?::\s*number\s*)?=\s*-1\s*;/m;
		const declarers = (await SOURCES)
			.filter(({ text }) => declaration.test(text))
			.map(({ file, text }) => `${file}: ${declaration.exec(text)?.[1]}`);

		expect(declarers).toEqual(["config/optional-number.ts: UNSET_NUMBER"]);
	});

	/**
	 * Another project's `-1` is not ours. llama.cpp reports `n_predict: -1` for "unlimited"
	 * and `config/model-discovery.ts` reads it, so a check keyed on the bare number would
	 * flag a correct file. Pinning that this specific reader is NOT a hit is what documents
	 * the boundary, so the next person to tighten the regex sees which case they may break.
	 */
	it("does not flag an unrelated protocol sentinel", async () => {
		const files = await SOURCES;
		const discovery = files.find(({ file }) => file === "config/model-discovery.ts");

		expect(discovery?.text).toContain("isLlamaCppUnlimitedSentinel");
		expect(sentinelComparisons(files, optionalNumericLeaves()).map(hit => hit.file)).not.toContain(
			"config/model-discovery.ts",
		);
	});

	/**
	 * The number itself, asserted once. The constant exists only so the UI can recognise what
	 * an older version wrote and so the migration has one name for it; a change here is a
	 * change to how every pre-existing config is read, and it should not pass unnoticed.
	 */
	it("is the value older configs actually stored", () => {
		expect(UNSET_NUMBER).toBe(-1);
	});
});
