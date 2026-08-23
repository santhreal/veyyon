/**
 * WHY THIS EXISTS. `prompts/ids.generated.ts` is the id space the eval-override refusal
 * reads, written down so a launch does not construct every prompt registry to answer one
 * question. A written-down copy of a derived fact goes stale in silence: add a prompt,
 * forget `bun run gen:prompt-ids`, and an arm that overrides it is refused as a typo.
 *
 * THE CLASS THIS CLOSES. Both directions of the copy, and the behaviour that depends on
 * it. The file is compared against the generator's own output for the live registries, so
 * a prompt added, removed or renamed in any of the four packages fails here; and the
 * refusal is driven through `buildSystemPrompt`'s guard rather than asserted structurally,
 * so a check that stopped running would fail too.
 *
 * WHAT IT DOES NOT CATCH. A prompt registered under an id that is wrong in the same way in
 * both places — the registry and the generated list agree because one is generated from
 * the other. `prompt-registry-coverage` owns whether a `.md` file is registered at all.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { aiPrompts } from "@veyyon/ai/prompts/registry";
import { $env } from "@veyyon/utils";
import { renderPromptIdModule } from "../../scripts/gen-prompt-ids";
import { allPromptIds, PROMPT_REGISTRIES } from "../../src/prompts/all-registries";
import { assertEvalPromptOverrideIdsExist, unknownEvalPromptOverrideIds } from "../../src/prompts/eval-overrides";
import { PROMPT_IDS, PROMPT_REGISTRY_COUNT } from "../../src/prompts/ids.generated";

const GENERATED = path.join(import.meta.dirname, "..", "..", "src", "prompts", "ids.generated.ts");

const before = $env.VEYYON_EVAL_PROMPTS;

afterEach(() => {
	if (before === undefined) delete $env.VEYYON_EVAL_PROMPTS;
	else $env.VEYYON_EVAL_PROMPTS = before;
});

describe("the generated prompt id list", () => {
	it("is what the generator writes for the registries in this build", () => {
		const rendered = renderPromptIdModule(allPromptIds(), PROMPT_REGISTRIES.length);

		expect(fs.readFileSync(GENERATED, "utf8")).toBe(rendered);
	});

	it("holds every id the registries hold, and no others", () => {
		expect([...PROMPT_IDS]).toEqual([...allPromptIds()].sort());
	});

	it("counts the registries the refusal points at", () => {
		expect(PROMPT_REGISTRY_COUNT).toBe(PROMPT_REGISTRIES.length);
	});
});

describe("an eval prompt override names an id this build has", () => {
	it("accepts an id from another package's registry, whatever the import order was", () => {
		// The point of an id space rather than a claim: this id belongs to `@veyyon/ai`, whose
		// registry a session constructs at a moment this check knows nothing about.
		const foreign = aiPrompts.ids[0] as string;
		$env.VEYYON_EVAL_PROMPTS = JSON.stringify({ [foreign]: "REPLACED" });

		expect(PROMPT_IDS).toContain(foreign);
		expect(unknownEvalPromptOverrideIds()).toEqual([]);
		expect(() => assertEvalPromptOverrideIdsExist()).not.toThrow();
	});

	it("refuses an id no registry has, naming it and its nearest real id", () => {
		$env.VEYYON_EVAL_PROMPTS = JSON.stringify({ "tools/bsh": "REPLACED" });

		expect(unknownEvalPromptOverrideIds()).toEqual(["tools/bsh"]);
		expect(() => assertEvalPromptOverrideIdsExist()).toThrow(/tools\/bsh/);
		expect(() => assertEvalPromptOverrideIdsExist()).toThrow(/tools\/bash/);
	});

	it("refuses a bare name, which is the mistake the hint exists for", () => {
		$env.VEYYON_EVAL_PROMPTS = JSON.stringify({ bash: "REPLACED" });

		expect(() => assertEvalPromptOverrideIdsExist()).toThrow(/An id is the path under a registry's directory/);
	});

	it("passes when the variable is not set at all", () => {
		delete $env.VEYYON_EVAL_PROMPTS;

		expect(unknownEvalPromptOverrideIds()).toEqual([]);
		expect(() => assertEvalPromptOverrideIdsExist()).not.toThrow();
	});
});
