/**
 * WHY: A `.prompts.yml` key that no registry holds is not an error the agent can absorb —
 * it is either a hard refusal in every trial of the arm, or, before the refusal existed,
 * an arm that ran the shipped prompt while the results table called it a treatment. The
 * runner is where a typo should cost nothing: it can enumerate the id space of the tree
 * it is about to build, and does, so the run stops before a container starts.
 *
 * The id space is read from the registries themselves, exactly as the runner reads the
 * settings schema to decide whether an arm names a real setting. That is the property
 * this suite defends hardest: a hardcoded list here would go stale the first time a
 * prompt is added, and a stale list refusing a valid id is worse than no check at all.
 *
 * What it does not catch: whether the agent inside the container applies a payload it
 * accepts (`packages/coding-agent/test/cli/an-eval-prompt-override-must-reach-the-model-or-be-refused.test.ts`
 * drives that through the real CLI), and Docker delivery of the staged JSON.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { PROMPT_ID_SHAPE_HINT } from "@veyyon/utils";
import YAML from "yaml";
import { armsDir } from "../../../engine/package-paths";
import { knownPromptIds, promptOverrideIdError } from "../../../engine/prompt-overrides";

const ARMS_DIR = armsDir();

/** Every arm that ships a prompt override, with its parsed mapping. */
const shippedPromptArms = fs
	.readdirSync(ARMS_DIR)
	.filter(name => name.endsWith(".prompts.yml"))
	.map(name => ({
		arm: name.slice(0, -".prompts.yml".length),
		overrides: (YAML.parse(fs.readFileSync(path.join(ARMS_DIR, name), "utf8")) ?? {}) as Record<string, unknown>,
	}));

describe("the id space the runner checks against", () => {
	it("comes from the registries, so it holds ids from each of them", () => {
		const ids = knownPromptIds();

		// A broken import would return an empty list and turn the check into a rubber stamp
		// that accepts every typo, which is the failure mode worth naming.
		expect(ids.length).toBeGreaterThan(100);
		expect(ids).toContain("tools/bash");
		expect(ids).toContain("dialect/anthropic");
		expect(ids).toContain("compaction/summarization-system");
		expect([...ids]).toEqual([...ids].sort());
	});
});

describe("promptOverrideIdError", () => {
	it("accepts a mapping whose every key is a registered prompt", () => {
		expect(promptOverrideIdError("candidate", { "tools/bash": "text", "tools/read": "text" })).toBeNull();
	});

	it("accepts an empty mapping, which is an arm that overrides nothing", () => {
		expect(promptOverrideIdError("candidate", {})).toBeNull();
	});

	it("explains what an id is in the same words the app's own refusal uses", () => {
		// One owner for the sentence, because both refusals answer one operator question:
		// this one before a container starts, the app's at prompt assembly. Two hand-written
		// explanations of the same rule make a reader work out whether they are the same rule.
		const message = promptOverrideIdError("candidate", { "tools/bash.md": "text" });

		expect(message).toContain(PROMPT_ID_SHAPE_HINT);
	});

	it("names the unknown id, the arm, and the id that exists", () => {
		const problem = promptOverrideIdError("candidate", { "tools/bsh": "text" });

		expect(problem).not.toBeNull();
		expect(problem).toContain('arm "candidate"');
		expect(problem).toContain("candidate.prompts.yml");
		expect(problem).toContain("tools/bsh");
		expect(problem).toContain("tools/bash");
	});

	it("reports every unknown id, not the first", () => {
		// A hand-written file gets a whole family of ids wrong the same way (a prefix that is
		// not there, a `.md` left on the end), and one-per-run is how that takes four runs.
		const problem = promptOverrideIdError("candidate", {
			"tools/bash.md": "text",
			bash: "text",
			"tools/bash": "text",
		});

		expect(problem).toContain("tools/bash.md");
		expect(problem).toContain("\n  bash");
		expect(problem).toContain("2 prompt id(s)");
	});

	it("checks against the ids it is given, so the caller decides the id space", () => {
		expect(promptOverrideIdError("candidate", { "only/known": "text" }, ["only/known"])).toBeNull();
		expect(promptOverrideIdError("candidate", { "tools/bash": "text" }, ["only/known"])).toContain("tools/bash");
	});
});

describe("every prompt override shipped in arms/", () => {
	it("exists, so no committed arm is a treatment that overrides nothing", () => {
		expect(shippedPromptArms.length).toBeGreaterThan(0);
	});

	it.each(shippedPromptArms)("$arm names only ids a registry holds", ({ arm, overrides }) => {
		expect(promptOverrideIdError(arm, overrides)).toBeNull();
	});

	it.each(shippedPromptArms)("$arm replaces text, never blanks a prompt", ({ overrides }) => {
		// An empty replacement is a legal payload and a useless arm: the model is told nothing
		// where instructions belonged, so the measurement is of a missing prompt rather than of
		// a different one. If an ablation is what is wanted, a statement is the vehicle.
		for (const [id, value] of Object.entries(overrides)) {
			expect(typeof value, id).toBe("string");
			expect(String(value).trim().length, id).toBeGreaterThan(0);
		}
	});
});
