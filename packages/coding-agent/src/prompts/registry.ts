/**
 * Every prompt veyyon sends a model, owned in ONE place.
 *
 * WHY THIS FILE IS THE OWNER AND NOT A DESCRIPTION OF ONE. Prompts used to be
 * addressed by ad-hoc relative path from wherever they happened to be used: 160
 * separate `import … with { type: "text" }` specifiers spread over 85 files, 27
 * of them in `session/agent-session.ts` alone. A sibling registry listed 23 of
 * the 143 prompts and recorded each one's location a SECOND time, as a
 * repository-relative string the compiler cannot see. So a prompt's home was
 * written down twice in two spellings that nothing kept in agreement, most
 * prompts were written down nowhere, and "what prompts does veyyon send" was a
 * grep rather than a list.
 *
 * Here the import IS the registration. Each row holds the imported text next to
 * that prompt's id and purpose, so the path exists exactly once and typechecks,
 * and a row cannot describe a file that is not there. Consumers take prompts
 * from `PROMPTS` by id; `PromptId` is the union of the real ids, so a typo is a
 * compile error rather than an `undefined` that renders as the empty string.
 *
 * THE ROWS LIVE ONE MODULE PER DIRECTORY, and this file aggregates them. It held
 * all 163 `import … with { type: "text" }` specifiers itself, which made importing
 * ONE prompt reach all 163: `tools/read.ts` needs `PROMPTS["tools/read"]` to render
 * its own description and paid 167 modules for that string, the largest single edge
 * it had, and 95 files in this package import a prompt the same way. Each directory
 * now owns its rows in `<directory>/rows.ts`, this file spreads them into the same
 * `PROMPTS`, and a consumer imports the directory it belongs to:
 *
 *   import { toolsPrompts } from "../prompts/tools/rows";
 *   const description = toolsPrompts["tools/read"].text;
 *
 * Take the aggregate instead when a module genuinely spans directories, which three
 * of them do, or when the id is not statically known (`requirePrompt`).
 *
 * COVERAGE IS STRUCTURAL, and the split did not weaken it. Every `.md` under
 * `src/prompts/` is imported by exactly ONE row module, every row module is
 * aggregated here, and nothing else in the repository may import a `.md`
 * (`prompt-registry-coverage` pins all three). A new prompt is therefore
 * unreachable until it is registered, which is why the count cannot drift back to
 * describing a fraction of them.
 *
 * DIRECTORIES, and what each one means. Every prompt belongs to exactly one, and
 * the name predicts the contents so a reader can find one without grepping:
 *
 *   session/        what defines a session before any turn runs: the system
 *                   prompt, the custom-prompt wrapper, the project footer, the
 *                   personalities, and the mode banners that reframe the whole
 *                   session.
 *   turn-control/   what starts, restarts, interrupts or pushes on an in-flight
 *                   turn: continuations, stop retries, loop redirects, the
 *                   pre-walk checks, and the todo and delegation nudges.
 *   side-channel/   turns that reuse the session's context but are not the task:
 *                   a side question, a recap, an IRC message, a speech rewrite,
 *                   a fork's handover.
 *   subagent/       what a delegated agent runs under, and what creates or
 *                   orchestrates one.
 *   plan-mode/      the read-only contract and its handovers.
 *   agents/         the bundled agent definitions themselves.
 *   tools/          one description per tool, plus the sub-model system prompts
 *                   a tool drives (`*-system.md`).
 *   rules/          user-defined rule (TTSR) violations.
 *   autolearn/      managed-skill guidance and its capture turn.
 *   titles/         naming a session.
 *   thinking/       classifying how much reasoning a turn needs.
 *   memories/       extracting, consolidating and reading long-term memory.
 *   commit/,        the commit flows, mapped and reduced.
 *   commit-agentic/
 *   goals/          goal mode.
 *   advisor/        the background advisor.
 *   autoresearch/   the autoresearch loop.
 *   skills/         wrapping a skill body.
 *   steering/       messages that arrive mid-turn and take priority.
 *   requests/       whole tasks veyyon asks itself to perform (review, CI green).
 *   bench/          fixed generation requests used for measurement.
 *
 * A prompt that fits none of these does not get a new single-file directory: put
 * it in the closest one. A directory earns existence at two files.
 *
 * ADDING A PROMPT: drop the `.md` under the directory that matches WHEN it
 * fires, add its import and its row to that directory's `rows.ts`, and use it
 * through that module (or through `PROMPTS`, which is the same row).
 */
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

/**
 * The row shape and the section shape both come from `@veyyon/utils`, re-exported
 * here so 160 call sites keep taking them from the registry they already import.
 *
 * They were declared in this file, and `@veyyon/agent-core`'s registry declared its
 * own copy of `PromptEntry` that had no `sections` field. Two packages describing one
 * concept with two interfaces is how a prompt ends up unable to say how it divides
 * depending on which registry happens to hold it. There is now one declaration, in
 * the one package every registry already depends on.
 */
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

/**
 * Every prompt, by id. The id is the file's path under `src/prompts/` without its
 * extension, so a row and its file are found from each other by reading.
 */
export const PROMPTS = codingAgentPrompts.prompts;

/** The id of a registered prompt. A value outside this union is a compile error. */
export type PromptId = keyof typeof PROMPTS;

/** Every registered id, for enumeration (inspection commands, coverage checks). */
export const PROMPT_IDS = codingAgentPrompts.ids;

/**
 * The text of a registered prompt.
 *
 * `PROMPTS[id].text` is equivalent and preferred at a call site that already knows its
 * id literally. This exists for the paths that carry an id in a variable, where the
 * indexed form would otherwise widen to `string`.
 */
export const promptText = codingAgentPrompts.text;

/**
 * A prompt looked up by an id that is not statically known.
 *
 * Throws rather than returning undefined: an unknown id degrading to a missing prompt
 * means the model silently receives nothing where instructions belonged, which reads
 * downstream as the model ignoring its brief. The shared lookup keeps that answer the
 * same in every package, and it names the near misses so a typo in one of 160 ids is a
 * suggestion rather than a search.
 */
export const requirePrompt = codingAgentPrompts.require;
