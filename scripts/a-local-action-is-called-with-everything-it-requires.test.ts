/**
 * Local composite actions: every call site supplies every required input, and the shared
 * ones stay shared.
 *
 * WHY THIS SUITE EXISTS. Two failure modes, both silent, both paid for at the worst moment.
 *
 * A missing required input is not an error on GitHub. `required: true` in an action's manifest
 * is documentation: the runner logs a warning nobody reads and hands the step an EMPTY string.
 * For `ts-test-env` that means downloading `veyyon-natives-linux-x64-*-h` with no hash — an
 * artifact that does not exist — so the bucket runs against a missing addon and reports whatever
 * that produces, which is never "you forgot an input".
 *
 * The second is drift between copies. Five test jobs each hand-rolled the same twenty lines to
 * resolve an artifact run id and download the Linux x64 addon; the release path already carries a
 * separate suite (`release-native-artifacts-match-ci.test.ts`) that exists purely because those
 * artifact names drift apart when they are written in more than one place. The five copies are one
 * action now, and this pins the download to it, so a sixth copy is a red suite rather than a
 * bucket that quietly tests without the native addon.
 *
 * WHAT IT CLOSES. Every local action and every call site, workflow or nested action, enumerated
 * from disk at run time. A new action, a new required input, or a new call site that misses one
 * turns this red by default.
 *
 * WHAT IT DOES NOT CATCH. An input that is supplied but wrong (an empty expression, the wrong
 * `needs` reference), and an action whose input SHOULD be required but is not declared so.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const WORKFLOWS = path.join(REPO_ROOT, ".github", "workflows");
const ACTIONS = path.join(REPO_ROOT, ".github", "actions");

interface Step {
	uses?: string;
	with?: Record<string, unknown>;
	name?: string;
}

interface ActionDocument {
	inputs?: Record<string, { required?: boolean }>;
	runs?: { steps?: Step[] };
}

/** Every local action, by directory name, with the inputs it declares mandatory. */
function requiredInputsByAction(): Map<string, string[]> {
	const required = new Map<string, string[]>();
	for (const dir of fs.readdirSync(ACTIONS).sort()) {
		const manifest = path.join(ACTIONS, dir, "action.yml");
		if (!fs.existsSync(manifest)) continue;
		const doc = Bun.YAML.parse(fs.readFileSync(manifest, "utf8")) as ActionDocument;
		required.set(
			dir,
			Object.entries(doc.inputs ?? {})
				.filter(([, spec]) => spec?.required === true)
				.map(([name]) => name),
		);
	}
	return required;
}

interface CallSite {
	/** Where a failure should send the reader. */
	where: string;
	action: string;
	supplied: string[];
}

/** Every `uses: ./.github/actions/...`, in a workflow job or inside another action. */
function callSites(): CallSite[] {
	const sites: CallSite[] = [];
	const collect = (where: string, steps: Step[] | undefined) => {
		for (const step of steps ?? []) {
			const uses = step?.uses ?? "";
			if (!uses.startsWith("./.github/actions/")) continue;
			sites.push({ where, action: path.basename(uses), supplied: Object.keys(step.with ?? {}) });
		}
	};
	for (const file of fs.readdirSync(WORKFLOWS).sort()) {
		if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
		const doc = Bun.YAML.parse(fs.readFileSync(path.join(WORKFLOWS, file), "utf8")) as {
			jobs?: Record<string, { steps?: Step[] }>;
		};
		for (const [job, body] of Object.entries(doc.jobs ?? {})) collect(`${file}: ${job}`, body?.steps);
	}
	for (const dir of fs.readdirSync(ACTIONS).sort()) {
		const manifest = path.join(ACTIONS, dir, "action.yml");
		if (!fs.existsSync(manifest)) continue;
		const doc = Bun.YAML.parse(fs.readFileSync(manifest, "utf8")) as ActionDocument;
		collect(`action: ${dir}`, doc.runs?.steps);
	}
	return sites;
}

describe("a local action is called with everything it requires", () => {
	it("reads the actions and the call sites it claims to check", () => {
		// Every assertion below passes over an empty sweep, so prove the sweep found the tree.
		const required = requiredInputsByAction();
		expect([...required.keys()]).toContain("ts-test-env");
		expect(callSites().length).toBeGreaterThan(20);
	});

	it("supplies every input the action declares required", () => {
		const required = requiredInputsByAction();
		const gaps = callSites().flatMap(site => {
			const inputs = required.get(site.action);
			if (inputs === undefined) return [`${site.where} uses ./.github/actions/${site.action}, which does not exist`];
			const missing = inputs.filter(input => !site.supplied.includes(input));
			return missing.length === 0 ? [] : [`${site.where} -> ${site.action} is missing: ${missing.join(", ")}`];
		});

		expect(
			gaps,
			"GitHub does not fail a step for a missing required input; it warns and passes an empty " +
				"string, so the action runs with a hole in it. Supply the input at the call site.",
		).toEqual([]);
	});

	/**
	 * The Linux x64 test addon has exactly one download path.
	 *
	 * Not the release artifacts: `release_binary` and `release_github` download per-platform and
	 * all-platform sets for different reasons, and forcing those through a test-environment action
	 * would couple two paths that have never shared a requirement.
	 */
	it("downloads the Linux x64 test addon only through the shared action", () => {
		const inWorkflows: string[] = [];
		for (const file of fs.readdirSync(WORKFLOWS).sort()) {
			if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
			const doc = Bun.YAML.parse(fs.readFileSync(path.join(WORKFLOWS, file), "utf8")) as {
				jobs?: Record<string, { steps?: Step[] }>;
			};
			for (const [job, body] of Object.entries(doc.jobs ?? {})) {
				for (const step of body?.steps ?? []) {
					if (!(step?.uses ?? "").startsWith("actions/download-artifact@")) continue;
					const pattern = String(step.with?.pattern ?? step.with?.name ?? "");
					if (pattern.includes("veyyon-natives-linux-x64")) inWorkflows.push(`${file}: ${job}`);
				}
			}
		}

		expect(
			inWorkflows,
			"the resolve-then-download pair belongs in ./.github/actions/ts-test-env. Five jobs used to " +
				"carry their own copy, and a copy is how the artifact name drifts from the one the build " +
				"job wrote.",
		).toEqual([]);

		const shared = Bun.YAML.parse(
			fs.readFileSync(path.join(ACTIONS, "ts-test-env", "action.yml"), "utf8"),
		) as ActionDocument;
		const downloads = (shared.runs?.steps ?? []).filter(step =>
			(step?.uses ?? "").startsWith("actions/download-artifact@"),
		);
		expect(downloads).toHaveLength(1);
		expect(String(downloads[0]?.with?.pattern)).toContain("veyyon-natives-linux-x64");

		const users = callSites().filter(site => site.action === "ts-test-env");
		expect(users.length).toBeGreaterThanOrEqual(5);
	});
});
