/**
 * The bench documentation names arms, task sets, and a model that actually exist
 * and actually agree with the code.
 *
 * WHY THIS SUITE EXISTS. Bench docs drift in a uniquely expensive way. A wrong
 * sentence in a normal README costs a reader a minute; a wrong arm name or model
 * id in THIS one costs a multi-hour, real-quota run, or worse, silently measures
 * the wrong condition. Three real instances, all live on the same day:
 *
 *   - the README's canonical comparison table named `argot-setting-only` and
 *     `candidate-argot-nudge` while the files on disk were `lexpack-*`, so two of
 *     the five documented comparisons could not be run at all,
 *   - the evals SKILL's copy-paste command passed `--model ...gemini-3.6-flash`
 *     while every encode arm allowlisted `gemini-3.5-flash`, so the documented
 *     command was refused by the pre-run treatment guard,
 *   - `BACKLOG.md` pointed 19 times at `packages/argot/`, a directory that does
 *     not exist (the package named `argot` lived in `packages/lexpack/` at the time;
 *     both now agree on `argot`).
 *
 * None of those is catchable by a typecheck, and none of them announces itself:
 * the docs read fine, and the failure lands on whoever tries to follow them.
 *
 * So the rule is that a NAME appearing in the docs must resolve. These tests
 * deliberately assert against the filesystem and the source rather than against a
 * second list, because a list of expected names is one more thing to drift.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseSectionOverridesJson } from "@veyyon/coding-agent/system-prompt-builder/default-template";
import { parseStatementOverridesJson } from "@veyyon/coding-agent/system-prompt-builder/statement-registry";
import YAML from "yaml";
import { getAllRegisteredSystemNames } from "../../../src/harnesses/registry";
import { DEFAULT_MODEL } from "../../../src/harnesses/system-comparison";
import { armsDir, deepSweSuiteDir, evalsPackageDir, repoRootDir, taskListsDir } from "../../../src/paths";
import {
	ARM_ATTACHMENT_KINDS,
	type ArmAttachmentKind,
	attachmentKindOf,
} from "../../../src/suites/deep-swe/arm-attachments";
import { armNamesIn } from "../../../src/suites/deep-swe/arm-fingerprint";
import { promptOverrideIdError } from "../../../src/suites/deep-swe/arm-prompts";

const SUITE_DIR = deepSweSuiteDir();
const ARMS_DIR = armsDir();
const TASKS_DIR = taskListsDir();
const REPO_ROOT = repoRootDir();
const README = fs.readFileSync(path.join(SUITE_DIR, "README.md"), "utf8");
const CLI_ARGS_TS = fs.readFileSync(path.join(SUITE_DIR, "src", "runner", "cli-args.ts"), "utf8");
const SKILL_PATH = path.join(REPO_ROOT, ".veyyon", "skills", "evals", "SKILL.md");
const SKILL = fs.existsSync(SKILL_PATH) ? fs.readFileSync(SKILL_PATH, "utf8") : "";

const armFiles = fs.readdirSync(ARMS_DIR);
/** Arm names, from the one owner of "which files in `arms/` are arms". This list used to be every
 * `*.yml`, which made `candidate-delivery-terse.sections.yml` a phantom arm named
 * `candidate-delivery-terse.sections` and quantified every check below over an arm nobody can run. */
const ARMS = armNamesIn(armFiles);
const SYSTEM_NAMES = getAllRegisteredSystemNames();
const TASK_SETS = fs.readdirSync(TASKS_DIR).filter(f => f.endsWith(".txt"));
/** Arm names a document references, found by the `--arms a,b` and backtick
 * forms the docs actually use. Filtered to plausible arm-shaped tokens so prose
 * words in backticks are not mistaken for arm names. */
function referencedArms(doc: string): string[] {
	const found = new Set<string>();
	for (const m of doc.matchAll(/--arms\s+([a-z0-9,-]+)/g)) {
		for (const name of (m[1] as string).split(",")) if (name) found.add(name);
	}
	// Backticked names that look like one of the known families. Anchored on the
	// prefixes the arm vocabulary actually uses so this cannot sweep up prose.
	for (const m of doc.matchAll(/`((?:baseline|decode|full|candidate|argot|lexpack)[a-z0-9-]*)`/g)) {
		found.add(m[1] as string);
	}
	// Task sets share the feature prefix (`argot-10` beside `argot-setting-only`)
	// and are checked separately below, so drop them here rather than reporting a
	// real task set as a missing arm.
	for (const file of TASK_SETS) found.delete(file.replace(/\.txt$/, ""));
	return [...found];
}

describe("every arm the docs name exists on disk", () => {
	/**
	 * THE regression. The README's canonical-comparison table is the first thing a
	 * reader copies, and it named two arms that had been renamed underneath it.
	 * Following it produced `create arms/argot-setting-only.yml` and a dead stop.
	 *
	 * Names are checked against the directory listing rather than a hardcoded set,
	 * so adding an arm needs no edit here and renaming one fails until the docs
	 * catch up, which is the intent.
	 */
	it("README names no arm that is missing from arms/", () => {
		const missing = referencedArms(README).filter(
			name => !ARMS.includes(name) && !ARMS.some(arm => arm.startsWith(name)) && !SYSTEM_NAMES.includes(name),
		);
		expect(missing).toEqual([]);
	});

	/** The SKILL is the copy-paste surface, so a stale name there is likelier to be
	 * run verbatim than one in the README. */
	it("the evals SKILL names no arm that is missing from arms/", () => {
		if (!SKILL) return;
		const missing = referencedArms(SKILL).filter(
			name => !ARMS.includes(name) && !ARMS.some(arm => arm.startsWith(name)) && !SYSTEM_NAMES.includes(name),
		);
		expect(missing).toEqual([]);
	});

	/** Sanity floor on the extraction itself: if the matcher silently stopped
	 * finding anything, the two tests above would pass vacuously forever. */
	it("actually finds arm references in the README", () => {
		expect(referencedArms(README).length).toBeGreaterThan(3);
	});
});

describe("every task set the docs name exists on disk", () => {
	/**
	 * A missing task file fails late, after auth preflight and container setup, so
	 * it wastes more of the operator's time than a missing arm does.
	 */
	it.each([
		["README", () => README],
		["evals SKILL", () => SKILL],
	])("%s names no tasks/*.txt that is missing", (_label, get) => {
		const doc = get();
		if (!doc) return;
		const referenced = [...doc.matchAll(/tasks\/([a-z0-9-]+\.txt)/g)].map(m => m[1] as string);
		const missing = [...new Set(referenced)].filter(file => !TASK_SETS.includes(file));
		expect(missing).toEqual([]);
	});

	/** Every shipped task set must declare its provenance, because the report
	 * banner and the "never headline a biased set" rule both depend on it. A set
	 * with no directive would be silently reportable as a headline. */
	it.each(fs.readdirSync(TASKS_DIR).filter(f => f.endsWith(".txt")))("%s declares @headline or @biased", file => {
		const text = fs.readFileSync(path.join(TASKS_DIR, file), "utf8");
		expect(/#\s*@(headline|biased)/.test(text)).toBe(true);
	});
});

describe("the declared test script does not scan the vendored trees", () => {
	/**
	 * Same thesis as the rest of this file, applied to `package.json` instead of
	 * prose: the command the project TELLS you to run has to actually work.
	 *
	 * `"test": "bun test"` did not. Bun's test runner walks the package looking for
	 * test files and does not respect `.gitignore`, and this package carries about
	 * 4GB of ignored working data (`repo-cache/` ~1.9G, `runs/` ~2.1G, `deep-swe/`
	 * ~38M). Every one of the 7 test files sits at the package root, so the walk
	 * found nothing extra and cost everything: the bare command blew a 120 second
	 * timeout while `bun test ./*.test.ts` ran the identical 287 tests in 0.14s.
	 *
	 * That is a ~1000x difference on the innermost loop of working in this package,
	 * and it silently gets worse every time a bench run writes another gigabyte
	 * into `runs/`, which is the insidious part: the command degrades as the
	 * package is used, so it works fine on a fresh clone and is unusable on the
	 * machine that actually runs benches. `bunfig.toml`'s pathIgnorePatterns now defends test discovery by ignoring these heavy trees directly.
	 */
	const pkg = JSON.parse(fs.readFileSync(path.join(evalsPackageDir(), "package.json"), "utf8")) as {
		scripts?: Record<string, string>;
	};

	it("scopes the python test script to the Pier agent unit tests", () => {
		expect(pkg.scripts?.["test:py"]).toBe("python3 -m unittest discover -s agents -p '*_test.py'");
	});

	/** `bunfig.toml`'s pathIgnorePatterns now protects test discovery from walking ignored data trees. */
	it("covers every gitignored heavy tree with a pathIgnorePatterns entry in bunfig.toml", () => {
		const gitignore = fs.readFileSync(path.join(evalsPackageDir(), ".gitignore"), "utf8");
		const ignoredDirs = gitignore
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.length > 0 && !line.startsWith("#") && line.endsWith("/"))
			.map(dir => dir.slice(0, -1));

		const bunfig = fs.readFileSync(path.join(evalsPackageDir(), "bunfig.toml"), "utf8");
		const parsed = Bun.TOML.parse(bunfig) as { test?: { pathIgnorePatterns?: string[] } };
		const ignorePatterns = parsed.test?.pathIgnorePatterns ?? [];

		const uncovered = ignoredDirs.filter(dir => {
			const expectedPattern = `${dir}/**`;
			return !ignorePatterns.some(pat => pat === expectedPattern || pat === `**/${dir}/**` || pat.startsWith(dir));
		});

		expect(uncovered).toEqual([]);
	});
});

describe("every flag the runner accepts is documented", () => {
	/**
	 * An undocumented flag is a feature nobody uses. `--dry-run` is the case in
	 * point: the single cheapest way to avoid burning a multi-hour real-quota run
	 * is worthless if the operator never learns it exists, and the two places they
	 * look are the README's flag list and the evals SKILL.
	 *
	 * The flag set is read out of `src/runner/cli-args.ts` (the sole flag parser)
	 * rather than listed here, so adding a flag fails this test until it is
	 * documented, which is the point. A hardcoded list would just be a third
	 * place to forget.
	 */
	// Two access forms, because a hyphenated flag cannot be a dot property:
	// `raw.model` and `raw["trial-timeout"]`. Matching both is what makes the set
	// complete; an earlier single combined pattern silently found only 2 of 11,
	// which is why the count floor below exists.
	const flags = [
		...new Set([
			...[...CLI_ARGS_TS.matchAll(/raw\.([a-z]+)/g)].map(m => m[1] as string),
			...[...CLI_ARGS_TS.matchAll(/raw\["([a-z-]+)"\]/g)].map(m => m[1] as string),
		]),
	];

	it("finds the runner's flag set", () => {
		expect(flags).toContain("dry-run");
		expect(flags.length).toBeGreaterThan(5);
	});

	it.each([
		["README", () => README],
		["evals SKILL", () => SKILL],
	])("%s documents every flag", (_label, get) => {
		const doc = get();
		if (!doc) return;
		const undocumented = flags.filter(name => !new RegExp(`--${name}\\b`).test(doc));
		expect(undocumented).toEqual([]);
	});
});

describe("the documented model agrees with the code and the arms", () => {
	/** Imported from the module that owns it, not pattern-matched out of run.ts:
	 * the old regex pinned the exact expression shape and broke the moment the
	 * default moved behind a ternary, silently reading "" and taking every
	 * assertion below with it. */
	const defaultModel = DEFAULT_MODEL;
	/** The bare logical id, which is what an arm allowlist matches on. */
	const defaultLogicalId = defaultModel.slice(defaultModel.lastIndexOf("/") + 1);

	it("the default model is a provider-qualified id", () => {
		expect(defaultLogicalId).not.toBe("");
		expect(defaultLogicalId).not.toBe(defaultModel);
	});

	/**
	 * THE guard against the most expensive drift of the three. The SKILL's
	 * copy-paste command passed a model that no encode arm allowlisted, so the
	 * pre-run treatment guard refused it. The documented command must be runnable
	 * as written.
	 */
	it("the SKILL's example command passes the default model", () => {
		if (!SKILL) return;
		// Anchored on the `provider/model` shape so this reads the runnable command
		// block and not the `- \`--model <id>\`:` flag-reference line above it, which
		// is prose and has no model in it. Getting that wrong made this test compare
		// against the literal string "<id>".
		const commandModel = /--model\s+(\S+\/\S+)/.exec(SKILL)?.[1];
		expect(commandModel).toBe(defaultModel);
	});

	/**
	 * Every arm that enables encoding must allowlist the default model, or a run
	 * using the documented defaults silently degrades to decode-only and measures
	 * the wrong condition. The runner refuses that at preflight; this catches it at
	 * test time, which is cheaper.
	 */
	it("every encode arm allowlists the default model", () => {
		const offenders: string[] = [];
		for (const arm of ARMS) {
			const text = fs.readFileSync(path.join(ARMS_DIR, `${arm}.yml`), "utf8");
			// An encode arm is one with a non-empty `models:` list. `models: []` is a
			// deliberate decode-only control and is correct as is.
			if (!/models:\s*\n(\s+#[^\n]*\n)*\s+-\s/.test(text)) continue;
			if (!text.includes(defaultLogicalId)) offenders.push(arm);
		}
		expect(offenders).toEqual([]);
	});

	/**
	 * No document may assert that a model id is unservable.
	 *
	 * This is a CONTENT rule rather than a naming one, and it exists because the
	 * claim "the 3.6 family is live-discovery-gated and resolves to nothing in the
	 * container" was false, was written as settled fact, and was then copied into
	 * three more files precisely because it read as settled. Two runs on that same
	 * id refute it: `argot-refusal-probe` 15/15 OK against `argot-budget16k-3.6`
	 * 40/40 failures. The real cause of a `Model "<id>" not found` at out=0tok is
	 * almost always an auth failure wearing the id's name, and every hour spent
	 * changing model ids instead of re-seeding the auth DB is an hour lost.
	 *
	 * The default model is a "known-good recent run" choice, and the docs must say
	 * only that.
	 */
	it.each([
		["README", () => README],
		["executor.ts", () => fs.readFileSync(path.join(SUITE_DIR, "src", "runner", "executor.ts"), "utf8")],
		["evals SKILL", () => SKILL],
		["arms/full.yml", () => fs.readFileSync(path.join(ARMS_DIR, "full.yml"), "utf8")],
		["arms/full-budget16k.yml", () => fs.readFileSync(path.join(ARMS_DIR, "full-budget16k.yml"), "utf8")],
	])("%s does not claim a model id is unservable", (_label, get) => {
		const doc = get();
		if (!doc) return;
		const claims = [/live-discovery-gated/i, /resolves to nothing/i, /does not resolve in the offline/i];
		const found = claims.filter(re => re.test(doc)).map(re => re.source);
		if (found.length === 0) return;

		// A file may STATE the claim in order to refute it, and `executor.ts`
		// deliberately does: the false conclusion is recorded there with the two
		// runs that refute it, rather than deleted, because deleting it is what
		// let it be rediscovered and re-propagated three times. So the rule is
		// not "never say the words", it is "never leave the words standing
		// unrefuted". A file carrying the claim must also carry an explicit
		// refutation nearby.
		//
		// Written as a requirement rather than an allowlist of files so a NEW file
		// that repeats the claim fails, which is the case that actually recurs.
		const refutations = [/was FALSE/i, /that assertion is false/i, /not a claim that/i, /NOT because/i];
		const refuted = refutations.some(re => re.test(doc));
		expect({ claims: found, refuted }).toEqual({ claims: found, refuted: true });
	});
});

describe("every shipped arm attachment is loadable by whatever consumes it", () => {
	/**
	 * An attachment the consumer rejects is worse than none: it is the file an operator
	 * COPIES to start an experiment, so a broken one propagates into everything derived
	 * from it, and the failure surfaces only once a container is running and being paid for.
	 *
	 * Each kind is validated through the code that reads it for real — the builder's own
	 * `parseSectionOverridesJson` and `parseStatementOverridesJson`, the runner's own
	 * `promptOverrideIdError` — never by re-checking the rules here. A second copy of "is
	 * this a legal section name" drifts from the real one, and this file would then certify
	 * examples the agent refuses.
	 *
	 * Swept over `ARM_ATTACHMENT_KINDS` rather than written out per kind: the two
	 * hand-written blocks this replaces covered sections and statements, and neither the
	 * prompt override nor the rule file had any check at all.
	 */
	const CONSUMERS: Record<ArmAttachmentKind["field"], (arm: string, text: string) => void> = {
		sections: (_arm, text) => {
			expect(Object.keys(parseSectionOverridesJson(JSON.stringify(YAML.parse(text)))).length).toBeGreaterThan(0);
		},
		statements: (_arm, text) => {
			expect(Object.keys(parseStatementOverridesJson(JSON.stringify(YAML.parse(text)))).length).toBeGreaterThan(0);
		},
		prompts: (arm, text) => {
			expect(promptOverrideIdError(arm, YAML.parse(text))).toBeNull();
		},
		rule: (_arm, text) => {
			// A rule is prompt text with no schema, so the only thing to check is that it says
			// something: an empty rule file is an arm whose treatment is nothing.
			expect(text.trim().length).toBeGreaterThan(0);
		},
	};

	const attachmentFiles = armFiles.filter(file => attachmentKindOf(file) !== undefined);
	const armOf = (file: string): string => file.slice(0, -(attachmentKindOf(file)?.suffix.length ?? 0));

	it("has a consumer for every kind the table declares", () => {
		// Pinned by exact equality: a kind added to the table with nothing validating its
		// shipped examples is how the prompt lane shipped with no check for two months.
		expect(Object.keys(CONSUMERS).sort()).toEqual(ARM_ATTACHMENT_KINDS.map(kind => kind.field).sort());
	});

	it.each(attachmentFiles)("%s is accepted by the code that reads it", file => {
		const kind = attachmentKindOf(file);
		if (kind === undefined) throw new Error("unreachable: filtered above");
		CONSUMERS[kind.field](armOf(file), fs.readFileSync(path.join(ARMS_DIR, file), "utf8"));
	});

	it.each(attachmentFiles)("%s has a config half so it can actually be run", file => {
		// An attachment with no arm is unrunnable, and the arm enumerators exclude
		// attachments, so nothing else would notice.
		expect(ARMS).toContain(armOf(file));
	});

	it.each(ARM_ATTACHMENT_KINDS.map(kind => kind.suffix))("ships at least one worked %s example", suffix => {
		// The prose is not the reference. Each lane was documented in the README before any
		// file existed, which left an operator to reconstruct the format from paragraphs.
		expect(attachmentFiles.filter(file => file.endsWith(suffix)).length).toBeGreaterThan(0);
	});
});
