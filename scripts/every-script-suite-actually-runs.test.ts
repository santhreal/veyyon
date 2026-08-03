/**
 * `repoScriptTests` is only worth maintaining if something runs it.
 *
 * For a long time nothing did. `case "workspace"` in `ci-test-ts.ts` carried its own hardcoded list
 * of 15 script test files, and because that bucket was the only one any workflow invoked, the other
 * 69 entries in `repoScriptTests` were named by no job at all. They were not reported as skipped, so
 * there was nothing to notice: 79 assertions sat red on main while every check reported green,
 * including a stale installer contract and an every-script-has-an-owner gate that had been failing
 * since the demos landed. The list looked authoritative and governed nothing.
 *
 * That is a nasty shape because the list keeps working as documentation while it has stopped working
 * as a gate, and each new suite added to it inherits the same silence. These tests assert the two
 * properties that make an entry in that array mean something.
 *
 * FIRST, every path in it exists. Bun ignores a filter that matches no file as long as some other
 * filter matches, so one typo'd entry is invisible rather than fatal: the run stays green and the
 * suite never executes. The array's own header records a `ci-test-ts.test.ts` entry that named a
 * file which never existed, and while wiring the fix above a `scripts/native-portability.test.ts`
 * entry was added by hand for a file that actually lives under `packages/natives/test/`. Nothing
 * complained either time.
 *
 * SECOND, a workflow actually runs the bucket. This is the property whose absence caused everything
 * above, and it is checked against the parsed workflow document rather than the file's text, because
 * a path or a command named in a YAML COMMENT is not a thing CI runs. A raw-text scan elsewhere in
 * this repo credited exactly that and reported two uncovered suites as covered.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { repoScriptTests } from "./ci-test-ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");

interface WorkflowStep {
	run?: string;
}

interface WorkflowJob {
	steps?: WorkflowStep[];
}

interface WorkflowDocument {
	jobs?: Record<string, WorkflowJob>;
}

const rootManifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
	scripts?: Record<string, string>;
};
const ROOT_SCRIPTS = rootManifest.scripts ?? {};

/** Every `run:` body in every workflow, from the PARSED document, so comments are already gone. */
function runBodies(): { workflow: string; job: string; run: string }[] {
	const bodies: { workflow: string; job: string; run: string }[] = [];
	for (const name of fs.readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith(".yml") || f.endsWith(".yaml"))) {
		const doc = Bun.YAML.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, name), "utf8")) as WorkflowDocument;
		for (const [job, spec] of Object.entries(doc.jobs ?? {})) {
			for (const step of spec.steps ?? []) {
				if (step.run) bodies.push({ workflow: name, job, run: step.run });
			}
		}
	}
	return bodies;
}

/**
 * Which `ci-test-ts.ts` bucket a command selects, following `bun run` through the manifest.
 *
 * Both spellings reach the same runner: a workflow may call `bun run test:scripts` or invoke
 * `bun scripts/ci-test-ts.ts scripts` directly, and a check that recognised only one would call a
 * correctly wired repo broken.
 */
function bucketsSelectedBy(command: string, seen = new Set<string>()): string[] {
	const buckets: string[] = [];
	for (const match of command.matchAll(/ci-test-ts\.ts\s+([\w-]+)/g)) buckets.push(match[1] as string);
	for (const match of command.matchAll(/bun run ([\w:-]+)/g)) {
		const name = match[1] as string;
		if (seen.has(name)) continue;
		seen.add(name);
		buckets.push(...bucketsSelectedBy(ROOT_SCRIPTS[name] ?? "", seen));
	}
	return buckets;
}

const RUN_BODIES = runBodies();

describe("repoScriptTests", () => {
	/**
	 * A path that matches no file runs nothing and says nothing, so the entry is pure decoration.
	 * Two entries have already been wrong this way.
	 */
	it("names only files that exist", () => {
		const missing = repoScriptTests.filter(rel => !fs.existsSync(path.join(REPO_ROOT, rel)));
		expect(missing).toEqual([]);
	});

	/** A duplicate is a merge artifact, and it makes the count lie about what is covered. */
	it("names each file once", () => {
		const duplicated = repoScriptTests.filter((rel, index) => repoScriptTests.indexOf(rel) !== index);
		expect(duplicated).toEqual([]);
	});
});

describe("the scripts bucket", () => {
	/**
	 * The property whose absence left 69 suites running nowhere. Asserted against parsed `run:`
	 * bodies, so a workflow that merely mentions the bucket in a comment does not count.
	 */
	it("is invoked by a workflow job", () => {
		const invocations = RUN_BODIES.filter(body => bucketsSelectedBy(body.run).includes("scripts")).map(
			body => `${body.workflow}::${body.job}`,
		);
		expect(invocations.length).toBeGreaterThan(0);
	});

	/**
	 * The job has to install first. These suites import from `packages/`, and a bucket that runs
	 * without `node_modules` fails on module resolution rather than on any contract it checks.
	 */
	it("is invoked by a job that installs dependencies", () => {
		const docs = fs
			.readdirSync(WORKFLOWS_DIR)
			.filter(f => f.endsWith(".yml") || f.endsWith(".yaml"))
			.map(name => ({
				name,
				doc: Bun.YAML.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, name), "utf8")) as WorkflowDocument,
			}));
		const installing: string[] = [];
		for (const { name, doc } of docs) {
			for (const [job, spec] of Object.entries(doc.jobs ?? {})) {
				const steps = spec.steps ?? [];
				const runsBucket = steps.some(step => bucketsSelectedBy(step.run ?? "").includes("scripts"));
				const installs = steps.some(step => (step.run ?? "").includes("bun install"));
				if (runsBucket && installs) installing.push(`${name}::${job}`);
			}
		}
		expect(installing.length).toBeGreaterThan(0);
	});
});

describe("the checker", () => {
	/**
	 * The discovery has to be able to fail. If `bucketsSelectedBy` silently matched nothing, both
	 * assertions above would be vacuous in precisely the way this file exists to prevent.
	 */
	it("does not credit a bucket nobody selects", () => {
		const invented = RUN_BODIES.filter(body => bucketsSelectedBy(body.run).includes("no-such-bucket"));
		expect(invented).toEqual([]);
	});

	/** Both spellings resolve, so the gate does not depend on how the job happens to be written. */
	it("recognises the direct and the bun run spelling", () => {
		expect(bucketsSelectedBy("bun scripts/ci-test-ts.ts scripts")).toContain("scripts");
		expect(bucketsSelectedBy("bun run test:scripts")).toContain("scripts");
	});

	/** A comment is not an invocation, which is the distinction the raw-text scan got wrong. */
	it("reads parsed run bodies, not workflow text", () => {
		const doc = Bun.YAML.parse(
			"jobs:\n  probe:\n    steps:\n      # bun run test:scripts\n      - run: echo hi\n",
		) as WorkflowDocument;
		const bodies = (doc.jobs?.probe?.steps ?? []).map(step => step.run ?? "");
		expect(bodies.some(body => bucketsSelectedBy(body).includes("scripts"))).toBe(false);
	});
});
