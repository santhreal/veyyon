/**
 * The `tools/` prompt rows: one description per tool, plus the sub-model system prompts a tool drives.
 *
 * WHY EACH DIRECTORY OWNS ITS OWN ROWS. `registry.ts` is still the ONE place that says which prompts exist,
 * and it aggregates every module like this one; what changed is that the 163 `import … with { type: "text" }`
 * specifiers no longer sit in a single module. They did, and the consequence was that importing one prompt
 * statically reached all 163: `tools/read.ts` needs `PROMPTS["tools/read"]` to render its own description and
 * paid 167 modules for it, the largest single edge that file had. A consumer now imports the directory it
 * belongs to and pays for that directory.
 *
 * THE INVARIANT IS UNCHANGED AND IS CHECKED ONE LEVEL DEEPER. Every `.md` under `src/prompts/` is imported by
 * exactly one row module, every row module is aggregated by `registry.ts`, and nothing else in the repository
 * may import a `.md`. `packages/coding-agent/test/core/prompt-registry-coverage.test.ts` pins all three, so a
 * new prompt is still unreachable code until it is registered, and a row still cannot describe a file that is
 * not there.
 *
 * DO NOT re-declare a row that another module already holds. The id-to-file mapping exists exactly once, here
 * for these ids, and the coverage suite fails on a second importer.
 */

import type { PromptEntry } from "@veyyon/utils/prompt-registry";

import toolsApplyPatch from "./apply-patch.md" with { type: "text" };
import toolsAsk from "./ask.md" with { type: "text" };
import toolsAstEdit from "./ast-edit.md" with { type: "text" };
import toolsAstGrep from "./ast-grep.md" with { type: "text" };
import toolsAsyncResult from "./async-result.md" with { type: "text" };
import toolsBash from "./bash.md" with { type: "text" };
import toolsBrowser from "./browser.md" with { type: "text" };
import toolsCheckpoint from "./checkpoint.md" with { type: "text" };
import toolsDebug from "./debug.md" with { type: "text" };
import toolsEval from "./eval.md" with { type: "text" };
import toolsGithub from "./github.md" with { type: "text" };
import toolsGlob from "./glob.md" with { type: "text" };
import toolsGoal from "./goal.md" with { type: "text" };
import toolsGrep from "./grep.md" with { type: "text" };
import toolsImageAttachmentDescribe from "./image-attachment-describe.md" with { type: "text" };
import toolsImageAttachmentDescribeSystem from "./image-attachment-describe-system.md" with { type: "text" };
import toolsImageGen from "./image-gen.md" with { type: "text" };
import toolsInspectImage from "./inspect-image.md" with { type: "text" };
import toolsInspectImageSystem from "./inspect-image-system.md" with { type: "text" };
import toolsIrc from "./irc.md" with { type: "text" };
import toolsJob from "./job.md" with { type: "text" };
import toolsLaunch from "./launch.md" with { type: "text" };
import toolsLearn from "./learn.md" with { type: "text" };
import toolsLsp from "./lsp.md" with { type: "text" };
import toolsLspLateDiagnostic from "./lsp-late-diagnostic.md" with { type: "text" };
import toolsManageSkill from "./manage-skill.md" with { type: "text" };
import toolsMemoryEdit from "./memory-edit.md" with { type: "text" };
import toolsPatch from "./patch.md" with { type: "text" };
import toolsRead from "./read.md" with { type: "text" };
import toolsRecall from "./recall.md" with { type: "text" };
import toolsReflect from "./reflect.md" with { type: "text" };
import toolsReplace from "./replace.md" with { type: "text" };
import toolsResolve from "./resolve.md" with { type: "text" };
import toolsRetain from "./retain.md" with { type: "text" };
import toolsRewind from "./rewind.md" with { type: "text" };
import toolsSearchToolBm25 from "./search-tool-bm25.md" with { type: "text" };
import toolsSetCwd from "./set-cwd.md" with { type: "text" };
import toolsSsh from "./ssh.md" with { type: "text" };
import toolsTask from "./task.md" with { type: "text" };
import toolsTaskSummary from "./task-summary.md" with { type: "text" };
import toolsTodo from "./todo.md" with { type: "text" };
import toolsVibeKill from "./vibe-kill.md" with { type: "text" };
import toolsVibeList from "./vibe-list.md" with { type: "text" };
import toolsVibeSend from "./vibe-send.md" with { type: "text" };
import toolsVibeSpawn from "./vibe-spawn.md" with { type: "text" };
import toolsVibeTurnResult from "./vibe-turn-result.md" with { type: "text" };
import toolsVibeWait from "./vibe-wait.md" with { type: "text" };
import toolsWebSearch from "./web-search.md" with { type: "text" };
import toolsWebSearchSystem from "./web-search-system.md" with { type: "text" };
import toolsWrite from "./write.md" with { type: "text" };

/** Every prompt under `src/prompts/tools/`, keyed by its id (the path under `src/prompts/`). */
export const toolsPrompts = {
	"tools/apply-patch": { text: toolsApplyPatch, purpose: "the apply_patch tool description" },
	"tools/ask": { text: toolsAsk, purpose: "the ask tool description" },
	"tools/ast-edit": { text: toolsAstEdit, purpose: "the ast_edit tool description" },
	"tools/ast-grep": { text: toolsAstGrep, purpose: "the ast_grep tool description" },
	"tools/async-result": {
		text: toolsAsyncResult,
		purpose: "delivers finished background job results back into the turn",
	},
	"tools/bash": { text: toolsBash, purpose: "the bash tool description" },
	"tools/browser": { text: toolsBrowser, purpose: "the browser tool description" },
	"tools/checkpoint": { text: toolsCheckpoint, purpose: "the checkpoint tool description" },
	"tools/debug": { text: toolsDebug, purpose: "the debug tool description" },
	"tools/eval": { text: toolsEval, purpose: "the eval tool description" },
	"tools/github": { text: toolsGithub, purpose: "the github tool description" },
	"tools/glob": { text: toolsGlob, purpose: "the glob tool description" },
	"tools/goal": { text: toolsGoal, purpose: "the goal tool description" },
	"tools/grep": { text: toolsGrep, purpose: "the grep tool description" },
	"tools/image-attachment-describe": {
		text: toolsImageAttachmentDescribe,
		purpose: "asks for a description of an attached image",
	},
	"tools/image-attachment-describe-system": {
		text: toolsImageAttachmentDescribeSystem,
		purpose: "describes an attached image when the model cannot see it",
	},
	"tools/image-gen": { text: toolsImageGen, purpose: "the image_gen tool description" },
	"tools/inspect-image": { text: toolsInspectImage, purpose: "the inspect_image tool description" },
	"tools/inspect-image-system": {
		text: toolsInspectImageSystem,
		purpose: "answers a question about an image for the inspect_image tool",
	},
	"tools/irc": { text: toolsIrc, purpose: "the irc tool description" },
	"tools/job": { text: toolsJob, purpose: "the job tool description" },
	"tools/launch": { text: toolsLaunch, purpose: "the launch tool description" },
	"tools/learn": { text: toolsLearn, purpose: "the learn tool description" },
	"tools/lsp": { text: toolsLsp, purpose: "the lsp tool description" },
	"tools/lsp-late-diagnostic": {
		text: toolsLspLateDiagnostic,
		purpose: "delivers LSP diagnostics that arrived after the edit returned",
	},
	"tools/manage-skill": { text: toolsManageSkill, purpose: "the manage_skill tool description" },
	"tools/memory-edit": { text: toolsMemoryEdit, purpose: "the memory_edit tool description" },
	"tools/patch": { text: toolsPatch, purpose: "the patch tool description" },
	"tools/read": { text: toolsRead, purpose: "the read tool description" },
	"tools/recall": { text: toolsRecall, purpose: "the recall tool description" },
	"tools/reflect": { text: toolsReflect, purpose: "the reflect tool description" },
	"tools/replace": { text: toolsReplace, purpose: "the replace tool description" },
	"tools/resolve": { text: toolsResolve, purpose: "the resolve tool description" },
	"tools/retain": { text: toolsRetain, purpose: "the retain tool description" },
	"tools/rewind": { text: toolsRewind, purpose: "the rewind tool description" },
	"tools/search-tool-bm25": { text: toolsSearchToolBm25, purpose: "the tool-discovery tool description" },
	"tools/set-cwd": { text: toolsSetCwd, purpose: "the set_cwd tool description" },
	"tools/ssh": { text: toolsSsh, purpose: "the ssh tool description" },
	"tools/task": { text: toolsTask, purpose: "the task tool description" },
	"tools/task-summary": { text: toolsTaskSummary, purpose: "renders a finished subagent's result back to its caller" },
	"tools/todo": { text: toolsTodo, purpose: "the todo tool description" },
	"tools/vibe-kill": { text: toolsVibeKill, purpose: "the vibe_kill tool description" },
	"tools/vibe-list": { text: toolsVibeList, purpose: "the vibe_list tool description" },
	"tools/vibe-send": { text: toolsVibeSend, purpose: "the vibe_send tool description" },
	"tools/vibe-spawn": { text: toolsVibeSpawn, purpose: "the vibe_spawn tool description" },
	"tools/vibe-turn-result": {
		text: toolsVibeTurnResult,
		purpose: "renders a vibe worker's finished turn back to the director",
	},
	"tools/vibe-wait": { text: toolsVibeWait, purpose: "the vibe_wait tool description" },
	"tools/web-search": { text: toolsWebSearch, purpose: "the web_search tool description" },
	"tools/web-search-system": { text: toolsWebSearchSystem, purpose: "instructions for the web-search sub-model" },
	"tools/write": { text: toolsWrite, purpose: "the write tool description" },
} satisfies Record<string, PromptEntry>;
