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
import YAML from "yaml";
import { armNamesIn } from "./arm-fingerprint";

const BENCH_DIR = import.meta.dir;
const REPO_ROOT = path.join(BENCH_DIR, "..", "..");
const README = fs.readFileSync(path.join(BENCH_DIR, "README.md"), "utf8");
const RUN_TS = fs.readFileSync(path.join(BENCH_DIR, "run.ts"), "utf8");
const SKILL_PATH = path.join(REPO_ROOT, ".veyyon", "skills", "evals", "SKILL.md");
const SKILL = fs.existsSync(SKILL_PATH) ? fs.readFileSync(SKILL_PATH, "utf8") : "";

const armFiles = fs.readdirSync(path.join(BENCH_DIR, "arms"));
/** Arm names, from the one owner of "which files in `arms/` are arms". This list used to be every
 * `*.yml`, which made `candidate-delivery-terse.sections.yml` a phantom arm named
 * `candidate-delivery-terse.sections` and quantified every check below over an arm nobody can run. */
const ARMS = armNamesIn(armFiles);
const TASK_SETS = fs.readdirSync(path.join(BENCH_DIR, "tasks")).filter(f => f.endsWith(".txt"));

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
			name => !ARMS.includes(name) && !ARMS.some(arm => arm.startsWith(name)),
		);
		expect(missing).toEqual([]);
	});

	/** The SKILL is the copy-paste surface, so a stale name there is likelier to be
	 * run verbatim than one in the README. */
	it("the evals SKILL names no arm that is missing from arms/", () => {
		if (!SKILL) return;
		const missing = referencedArms(SKILL).filter(
			name => !ARMS.includes(name) && !ARMS.some(arm => arm.startsWith(name)),
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
	it.each(fs.readdirSync(path.join(BENCH_DIR, "tasks")).filter(f => f.endsWith(".txt")))(
		"%s declares @headline or @biased",
		file => {
			const text = fs.readFileSync(path.join(BENCH_DIR, "tasks", file), "utf8");
			expect(/#\s*@(headline|biased)/.test(text)).toBe(true);
		},
	);
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
	 * machine that actually runs benches.
	 */
	const pkg = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, "package.json"), "utf8")) as {
		scripts?: Record<string, string>;
	};

	it("scopes the test script to the root test files", () => {
		expect(pkg.scripts?.test).toBe("bun test ./*.test.ts");
	});

	/** The scoping is only safe while every test file IS at the root. A future test
	 * in a subdirectory would be silently skipped by the glob, which is a worse
	 * failure than a slow run, so it fails here instead. */
	it("has every test file at the package root", () => {
		const rootTests = fs.readdirSync(BENCH_DIR).filter(f => f.endsWith(".test.ts"));
		expect(rootTests.length).toBeGreaterThan(5);

		const strays: string[] = [];
		for (const entry of fs.readdirSync(BENCH_DIR, { withFileTypes: true })) {
			// The ignored working-data trees are exactly what must not be walked.
			if (!entry.isDirectory() || ["repo-cache", "runs", "deep-swe", "node_modules"].includes(entry.name)) continue;
			for (const nested of fs.readdirSync(path.join(BENCH_DIR, entry.name))) {
				if (nested.endsWith(".test.ts")) strays.push(`${entry.name}/${nested}`);
			}
		}
		expect(strays).toEqual([]);
	});
});

describe("every flag the runner accepts is documented", () => {
	/**
	 * An undocumented flag is a feature nobody uses. `--dry-run` is the case in
	 * point: the single cheapest way to avoid burning a multi-hour real-quota run
	 * is worthless if the operator never learns it exists, and the two places they
	 * look are the README's flag list and the evals SKILL.
	 *
	 * The flag set is read out of `run.ts` rather than listed here, so adding a
	 * flag fails this test until it is documented, which is the point. A hardcoded
	 * list would just be a third place to forget.
	 */
	// Two access forms, because a hyphenated flag cannot be a dot property:
	// `args.model` and `args["trial-timeout"]`. Matching both is what makes the set
	// complete; an earlier single combined pattern silently found only 2 of 11,
	// which is why the count floor below exists.
	const flags = [
		...new Set([
			...[...RUN_TS.matchAll(/args\.([a-z]+)/g)].map(m => m[1] as string),
			...[...RUN_TS.matchAll(/args\["([a-z-]+)"\]/g)].map(m => m[1] as string),
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

describe("every shipped prompt-section arm is actually loadable", () => {
	/**
	 * A `.sections.yml` that the prompt builder would reject is worse than none at
	 * all: it is the file an operator COPIES to start a prompt experiment, so a
	 * broken one propagates into every experiment derived from it, and the failure
	 * only surfaces once a container is already running.
	 *
	 * Validated through the builder's OWN `parseSectionOverridesJson`, the same
	 * function the agent calls on the staged JSON, rather than by re-checking the
	 * rules here. Re-implementing "is this a legal section name" and "does it lead
	 * with its banner" would be a second copy of the contract that drifts from the
	 * real one, and this file would then certify examples the agent rejects.
	 */
	const sectionArms = armFiles.filter(f => f.endsWith(".sections.yml"));

	it.each(sectionArms)("%s is accepted by the prompt builder", async file => {
		const { parseSectionOverridesJson } = await import("@veyyon/coding-agent/system-prompt-builder/default-template");
		const parsed = YAML.parse(fs.readFileSync(path.join(BENCH_DIR, "arms", file), "utf8"));
		const overrides = parseSectionOverridesJson(JSON.stringify(parsed));

		expect(Object.keys(overrides).length).toBeGreaterThan(0);
	});

	/**
	 * Every sections file needs a config arm of the same name, or the runner has
	 * nothing to stage it against and the experiment cannot be selected with
	 * `--arms`. Easy to forget, since the sections file is the interesting half.
	 */
	it.each(sectionArms)("%s has a matching <arm>.yml", file => {
		const arm = file.replace(/\.sections\.yml$/, "");
		expect(ARMS).toContain(arm);
	});

	/**
	 * The lane must keep a worked example. It was documented in the README with no
	 * file on disk, which left an operator to reconstruct the format, the legal
	 * names, and the banner rule from prose before anything would run.
	 */
	it("ships at least one prompt-section example", () => {
		expect(sectionArms.length).toBeGreaterThan(0);
	});
});

describe("the documented model agrees with the code and the arms", () => {
	/** The default in `run.ts` is the single source of truth for what the docs may
	 * claim, so it is read out of the source rather than restated here. */
	const defaultModel = /args\.model \?\? "([^"]+)"/.exec(RUN_TS)?.[1] ?? "";
	/** The bare logical id, which is what an arm allowlist matches on. */
	const defaultLogicalId = defaultModel.slice(defaultModel.lastIndexOf("/") + 1);

	it("run.ts declares a default model at all", () => {
		expect(defaultModel).not.toBe("");
		expect(defaultLogicalId).not.toBe("");
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
			const text = fs.readFileSync(path.join(BENCH_DIR, "arms", `${arm}.yml`), "utf8");
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
		["run.ts", () => RUN_TS],
		["evals SKILL", () => SKILL],
		["arms/full.yml", () => fs.readFileSync(path.join(BENCH_DIR, "arms", "full.yml"), "utf8")],
		["arms/full-budget16k.yml", () => fs.readFileSync(path.join(BENCH_DIR, "arms", "full-budget16k.yml"), "utf8")],
	])("%s does not claim a model id is unservable", (_label, get) => {
		const doc = get();
		if (!doc) return;
		const claims = [/live-discovery-gated/i, /resolves to nothing/i, /does not resolve in the offline/i];
		const found = claims.filter(re => re.test(doc)).map(re => re.source);
		if (found.length === 0) return;

		// A file may STATE the claim in order to refute it, and `run.ts` deliberately
		// does: the false conclusion is recorded there with the two runs that refute
		// it, rather than deleted, because deleting it is what let it be rediscovered
		// and re-propagated three times. So the rule is not "never say the words", it
		// is "never leave the words standing unrefuted". A file carrying the claim
		// must also carry an explicit refutation nearby.
		//
		// Written as a requirement rather than an allowlist of files so a NEW file
		// that repeats the claim fails, which is the case that actually recurs.
		const refutations = [/was FALSE/i, /that assertion is false/i, /not a claim that/i, /NOT because/i];
		const refuted = refutations.some(re => re.test(doc));
		expect({ claims: found, refuted }).toEqual({ claims: found, refuted: true });
	});
});

describe("every shipped prompt-statement arm is actually loadable", () => {
	/**
	 * The same contract as the section arms above, at the granularity a rule has, and it needs its own
	 * check for the same reason: this is the file an operator COPIES to start an ablation, so a broken
	 * one propagates into every experiment derived from it and only surfaces once a container is
	 * running and being paid for.
	 *
	 * Validated through the builder's OWN `parseStatementOverridesJson`, the same function the agent
	 * calls on the staged JSON. A typo in a statement id is the interesting failure: the builder
	 * refuses it, so an arm with one would hard-error every trial rather than quietly bench the
	 * production prompt under a treatment's name, and this test is what catches it before the run.
	 */
	const statementArms = armFiles.filter(f => f.endsWith(".statements.yml"));

	it("ships at least one worked example, since the prose is not the reference", () => {
		expect(statementArms.length).toBeGreaterThan(0);
	});

	it.each(statementArms)("%s is accepted by the prompt builder", async file => {
		const { parseStatementOverridesJson } = await import(
			"@veyyon/coding-agent/system-prompt-builder/statement-registry"
		);
		const parsed = YAML.parse(fs.readFileSync(path.join(BENCH_DIR, "arms", file), "utf8"));
		const overrides = parseStatementOverridesJson(JSON.stringify(parsed));

		expect(Object.keys(overrides).length).toBeGreaterThan(0);
	});

	it.each(statementArms)("%s has a config half so it can actually be run", file => {
		// An attachment with no arm is unrunnable, and the arm enumerators exclude attachments, so
		// nothing else would notice.
		const arm = file.slice(0, -".statements.yml".length);

		expect(fs.existsSync(path.join(BENCH_DIR, "arms", `${arm}.yml`)), `${arm}.yml is missing`).toBe(true);
	});
});
