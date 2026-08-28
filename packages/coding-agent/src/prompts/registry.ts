/** Every prompt veyyon sends a model, owned in ONE place. addressed by ad-hoc relative path from wherever they happened to be used: 160 */
// From the module that defines them, not the `@veyyon/utils` barrel: 3 modules against 74.
import { definePromptRegistry, type PromptEntry, type PromptSection } from "@veyyon/utils/prompt-registry";
import { advisorPrompts } from "./advisor/rows";
import { agentsPrompts } from "./agents/rows";
import { autolearnPrompts } from "./autolearn/rows";
import { autoresearchPrompts } from "./autoresearch/rows";
import { benchPrompts } from "./bench/rows";
import { commitPrompts } from "./commit/rows";
import { commitAgenticPrompts } from "./commit-agentic/rows";
import { goalsPrompts } from "./goals/rows";
import { memoriesPrompts } from "./memories/rows";
import { planModePrompts } from "./plan-mode/rows";
import { requestsPrompts } from "./requests/rows";
import { rulesPrompts } from "./rules/rows";
import { sessionPrompts } from "./session/rows";
import { sideChannelPrompts } from "./side-channel/rows";
import { skillsPrompts } from "./skills/rows";
import { steeringPrompts } from "./steering/rows";
import { subagentPrompts } from "./subagent/rows";
import { thinkingPrompts } from "./thinking/rows";
import { titlesPrompts } from "./titles/rows";
import { toolsPrompts } from "./tools/rows";
import { turnControlPrompts } from "./turn-control/rows";

/** The row shape and the section shape both come from `@veyyon/utils`, re-exported here so 160 call sites keep taking them from the registry they already import. */
export type { PromptEntry, PromptSection };

export const codingAgentPrompts = definePromptRegistry("packages/coding-agent/src/prompts", {
	...advisorPrompts,
	...agentsPrompts,
	...autolearnPrompts,
	...autoresearchPrompts,
	...benchPrompts,
	...commitPrompts,
	...commitAgenticPrompts,
	...goalsPrompts,
	...memoriesPrompts,
	...planModePrompts,
	...requestsPrompts,
	...rulesPrompts,
	...sessionPrompts,
	...sideChannelPrompts,
	...skillsPrompts,
	...steeringPrompts,
	...subagentPrompts,
	...thinkingPrompts,
	...titlesPrompts,
	...toolsPrompts,
	...turnControlPrompts,
});

/** Every prompt, by id. The id is the file's path under `src/prompts/` without its extension, so a row and its file are found from each other by reading. */
export const PROMPTS = codingAgentPrompts.prompts;

/** The id of a registered prompt. A value outside this union is a compile error. */
export type PromptId = keyof typeof PROMPTS;

/** Every registered id, for enumeration (inspection commands, coverage checks). */
export const PROMPT_IDS = codingAgentPrompts.ids;

/** The text of a registered prompt. `PROMPTS[id].text` is equivalent and preferred at a call site that already knows its */
export const promptText = codingAgentPrompts.text;

/** A prompt looked up by an id that is not statically known. Throws rather than returning undefined: an unknown id degrading to a missing prompt */
export const requirePrompt = codingAgentPrompts.require;
