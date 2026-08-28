/**
 * Every prompt the TypeScript-edit suite itself sends a model, owned in ONE place.
 *
 * The adapter's registry one directory down covers what a scored run is asked to do.
 * These eight are the suite's own: four difficulty templates that decide how a
 * generated task is worded, and four Argot arms whose text decides what the token
 * delta is measured against. They were imported by relative path from `generate.ts`
 * and `argot-bench.ts` and appeared in no list, so the harness could not state what
 * it asked. The import IS the registration, the id is the path under this directory
 * without its extension, and `prompt-registry-coverage` pins both directions.
 */
import { definePromptRegistry, type PromptEntry } from "@veyyon/utils";
import argotForcedAdoption from "./argot-forced-adoption.md" with { type: "text" };
import argotSigilEmission from "./argot-sigil-emission.md" with { type: "text" };
import generateTaskEasy from "./generate-task-easy.md" with { type: "text" };
import generateTaskHard from "./generate-task-hard.md" with { type: "text" };
import generateTaskMedium from "./generate-task-medium.md" with { type: "text" };
import generateTaskNightmare from "./generate-task-nightmare.md" with { type: "text" };
import reproBarrelReexport from "./repro-barrel-reexport.md" with { type: "text" };
import reproNewFeature from "./repro-new-feature.md" with { type: "text" };

export type { PromptEntry };

export const typescriptEditSuitePrompts = definePromptRegistry("packages/evals/suites/typescript-edit/prompts", {
	"argot-forced-adoption": {
		text: argotForcedAdoption,
		purpose: "asks the model to write handles it was given, so adoption is measured rather than hoped for",
	},
	"argot-sigil-emission": {
		text: argotSigilEmission,
		purpose: "asks for a handle in running prose, which is where a decoder either holds or leaks",
	},
	"generate-task-easy": {
		text: generateTaskEasy,
		purpose: "states the defect and its exact line, the floor case for a generated edit task",
	},
	"generate-task-medium": {
		text: generateTaskMedium,
		purpose: "states the defect and the file, leaving the line to be found",
	},
	"generate-task-hard": {
		text: generateTaskHard,
		purpose: "states the symptom and the file, leaving the defect to be diagnosed",
	},
	"generate-task-nightmare": {
		text: generateTaskNightmare,
		purpose: "states the intended behavior only, leaving the file and the defect to be found",
	},
	"repro-barrel-reexport": {
		text: reproBarrelReexport,
		purpose: "the barrel re-export edit, an Argot arm whose handles are module paths",
	},
	"repro-new-feature": {
		text: reproNewFeature,
		purpose: "the new-feature edit, an Argot arm whose handles are symbols the model must introduce",
	},
});

/** Every prompt this suite sends, by id. */
export const TYPESCRIPT_EDIT_SUITE_PROMPTS = typescriptEditSuitePrompts.prompts;
