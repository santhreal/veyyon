/**
 * WHY: a scene under `proof/scenes/` waits for strings on a real screen, and a string the product
 * no longer prints does not fail fast. It burns its timeout, marks the shot missed, and the publish
 * step then copies whichever PNGs exist — leaving the PREVIOUS take's frame under that name, freshly
 * timestamped and indistinguishable from a new one. Two guards in the hero scene were in exactly
 * that state: the todo board stopped printing a count in its header, and "Status: complete" only
 * ever appears inside a goal details panel the scene never opens.
 *
 * The class is "a scene guard that nothing produces". `verifySceneSources` is the choke point every
 * needle passes through, so the invariant is asserted there rather than once per scene: a needle is
 * accepted only when some named source contains it, and an exemption must be written into the scene
 * by hand.
 *
 * What it does not catch: a needle that exists in the source but is unreachable in the state the
 * scene is in (the "Status: complete" case would pass if that literal were spelled out in a
 * component), and a scene whose guards are all fine but whose prompt cannot produce the state.
 * Those are review, not a gate.
 */
import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { agentSourceText, SCENE_HELPERS as HELPERS, type SceneSources, verifySceneSources } from "./verify-scene";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SCENES_DIR = path.join(REPO_ROOT, "proof", "scenes");

function sources(overrides: Partial<SceneSources> & { scene: string }): SceneSources {
	return {
		name: "fixture.sh",
		prompts: [],
		agentText: "",
		seed: "",
		...overrides,
	};
}

const problems = (input: Partial<SceneSources> & { scene: string }): string[] =>
	verifySceneSources(sources(input)).map(finding => finding.problem);

describe("a scene guard has to resolve to something that produces it", () => {
	it("accepts a needle the submitted prompt asks the model to print", () => {
		expect(
			problems({
				scene: 'wait_for_screen "BUILD VERIFIED: all green" 60\n',
				prompts: [{ path: "proof/prompts/x.md", text: "print exactly BUILD VERIFIED: all green" }],
			}),
		).toEqual([]);
	});

	it("accepts a needle the product's own source renders", () => {
		expect(
			problems({
				scene: 'wait_for_screen "Permission required" 60\n',
				agentText: 'const title = "Permission required";',
			}),
		).toEqual([]);
	});

	it("accepts a needle the sandbox seed pins through a seeded test", () => {
		expect(
			problems({
				scene: 'screen_has "AUTOPILOT"\n',
				seed: 'expect(first).toContain("AUTOPILOT");',
			}),
		).toEqual([]);
	});

	it("accepts a needle the scene itself types", () => {
		expect(
			problems({ scene: 'slash "/secret from-env K release-signature"\nscreen_has "release-signature"\n' }),
		).toEqual([]);
	});

	it("refuses a needle that only exists in the guard that waits for it", () => {
		// The scene file is not a source for itself, or every stale guard would prove itself by
		// being written down. This is the shape both hero-scene defects had.
		expect(problems({ scene: 'wait_for_screen "Todo 0/8 tasks" 420\n' })).toEqual([
			'waits for "Todo 0/8 tasks", which no prompt, source file, seed or scene line produces — rename the guard or declare it with "# needle-source: Todo 0/8 tasks -- <where it comes from>"',
		]);
	});

	it("accepts a needle whose source the scene declares by hand", () => {
		expect(
			problems({
				scene: '# needle-source: WARP CORE -- printed by the compiled binary\nwait_for_screen "WARP CORE" 60\n',
			}),
		).toEqual([]);
	});

	it("ignores a needle assembled from a shell variable, which only run time can resolve", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion in a scene fixture
		expect(problems({ scene: 'wait_for_screen "${SCENE_SIGNING_NUMBER}" 60\n' })).toEqual([]);
	});

	it("accepts a trailing colon the renderer adds to a name the prompt supplies", () => {
		expect(
			problems({
				scene: 'wait_for_screen "FlightAgent:" 60\n',
				prompts: [{ path: "proof/prompts/x.md", text: "dispatch FlightAgent to own the cli" }],
			}),
		).toEqual([]);
	});

	it("reports a prompt the scene submits and the repository does not have", () => {
		expect(
			problems({
				scene: "cat /repo/proof/prompts/gone.md\n",
				prompts: [{ path: "proof/prompts/gone.md", text: null }],
			}),
		).toEqual(["submits proof/prompts/gone.md, which does not exist"]);
	});
});

describe("a scene has to fail rather than hang or overwrite", () => {
	it("refuses a wait with no timeout", () => {
		expect(problems({ scene: 'wait_for_screen "Todos"\n', agentText: "Todos" })).toEqual([
			'wait_for_screen "Todos" has no numeric timeout, so a missing string waits forever',
		]);
	});

	it("accepts a timeout supplied through a variable", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion in a scene fixture
		expect(problems({ scene: 'wait_for_screen "Todos" "${WAIT}"\n', agentText: "Todos" })).toEqual([]);
	});

	it("refuses two shots under one name", () => {
		expect(problems({ scene: "shot goal-created\nshot goal-created\n" })).toEqual([
			'two shots are named "goal-created", so one overwrites the other',
		]);
	});

	it("refuses a scene that collects misses and exits clean", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion in a scene fixture
		expect(problems({ scene: 'MISSED="${MISSED:-} idle"\nshot idle\n' })).toEqual([
			"the scene collects MISSED but never fails on it, so a take publishes with shots it never got",
		]);
	});

	it("accepts a scene that fails on its collected misses", () => {
		expect(
			problems({
				// biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion in a scene fixture
				scene: 'MISSED="${MISSED:-} idle"\nif [ -n "${MISSED:-}" ]; then\n\texit 1\nfi\n',
			}),
		).toEqual([]);
	});
});

describe("every recorded scene in this repository", () => {
	it("passes the checker, so a new scene with a stale guard lands red", async () => {
		// The roster comes from the directory at run time: a scene added next year is covered the day
		// it lands, and a guard that stops resolving turns this red instead of costing a take.
		const entries = (await readdir(SCENES_DIR)).filter(entry => entry.endsWith(".sh")).sort();
		const helperNames = new Set<string>(HELPERS);
		const helpers = entries.filter(entry => helperNames.has(entry));
		expect(helpers).toEqual([...HELPERS]);
		const scenes = entries.filter(entry => !helperNames.has(entry));
		expect(scenes.length).toBeGreaterThan(20);

		const agentText = await agentSourceText();
		const seed = await readFile(path.join(REPO_ROOT, "proof", "docker", "seed-demo.sh"), "utf8");
		const findings: string[] = [];
		for (const entry of scenes) {
			const scene = await readFile(path.join(SCENES_DIR, entry), "utf8");
			const prompts = await Promise.all(
				[...scene.matchAll(/(?:\/repo\/)?(proof\/prompts\/[\w.-]+\.md)/g)].map(async match => ({
					path: match[1],
					text: await readFile(path.join(REPO_ROOT, match[1]), "utf8").catch(() => null),
				})),
			);
			for (const finding of verifySceneSources({ name: entry, scene, prompts, agentText, seed })) {
				findings.push(`${finding.scene}: ${finding.problem}`);
			}
		}
		expect(findings).toEqual([]);
	});
});
