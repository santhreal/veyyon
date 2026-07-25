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
 * COVERAGE IS STRUCTURAL. Every `.md` under `src/prompts/` is imported below,
 * and nothing outside this file may import one (`prompt-registry-coverage`
 * pins that). A new prompt is therefore unreachable until it is registered,
 * which is why the count cannot drift back to describing a fraction of them.
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
 * fires, add its import and its row here, and use it through `PROMPTS`.
 */
import type { BanneredSection } from "../system-prompt-builder/banner-grammar";
import advisorActiveRepoWatchdog from "./advisor/active-repo-watchdog.md" with { type: "text" };
import advisorAdviseTool from "./advisor/advise-tool.md" with { type: "text" };
import advisorContextFiles from "./advisor/context-files.md" with { type: "text" };
import advisorSystem from "./advisor/system.md" with { type: "text" };
import agentsDesigner from "./agents/designer.md" with { type: "text" };
import agentsFrontmatter from "./agents/frontmatter.md" with { type: "text" };
import agentsInit from "./agents/init.md" with { type: "text" };
import agentsLibrarian from "./agents/librarian.md" with { type: "text" };
import agentsReviewer from "./agents/reviewer.md" with { type: "text" };
import agentsScout from "./agents/scout.md" with { type: "text" };
import agentsTask from "./agents/task.md" with { type: "text" };
import autolearnGuidance from "./autolearn/guidance.md" with { type: "text" };
import autolearnGuidanceLearn from "./autolearn/guidance-learn.md" with { type: "text" };
import autolearnNudgeAutocontinue from "./autolearn/nudge-autocontinue.md" with { type: "text" };
import autoresearchCommandResume from "./autoresearch/command-resume.md" with { type: "text" };
import autoresearchPrompt from "./autoresearch/prompt.md" with { type: "text" };
import autoresearchPromptSetup from "./autoresearch/prompt-setup.md" with { type: "text" };
import autoresearchResumeMessage from "./autoresearch/resume-message.md" with { type: "text" };
import benchBalance from "./bench/balance.md" with { type: "text" };
import benchThroughput from "./bench/throughput.md" with { type: "text" };
import commitAnalysisSystem from "./commit/analysis-system.md" with { type: "text" };
import commitAnalysisUser from "./commit/analysis-user.md" with { type: "text" };
import commitChangelogSystem from "./commit/changelog-system.md" with { type: "text" };
import commitChangelogUser from "./commit/changelog-user.md" with { type: "text" };
import commitFileObserverSystem from "./commit/file-observer-system.md" with { type: "text" };
import commitFileObserverUser from "./commit/file-observer-user.md" with { type: "text" };
import commitMessageSystem from "./commit/message-system.md" with { type: "text" };
import commitReduceSystem from "./commit/reduce-system.md" with { type: "text" };
import commitReduceUser from "./commit/reduce-user.md" with { type: "text" };
import commitSummaryRetry from "./commit/summary-retry.md" with { type: "text" };
import commitSummarySystem from "./commit/summary-system.md" with { type: "text" };
import commitSummaryUser from "./commit/summary-user.md" with { type: "text" };
import commitTypesDescription from "./commit/types-description.md" with { type: "text" };
import commitAgenticAnalyzeFile from "./commit-agentic/analyze-file.md" with { type: "text" };
import commitAgenticSessionUser from "./commit-agentic/session-user.md" with { type: "text" };
import commitAgenticSplitConfirm from "./commit-agentic/split-confirm.md" with { type: "text" };
import commitAgenticSystem from "./commit-agentic/system.md" with { type: "text" };
import goalsGoalBudgetLimit from "./goals/goal-budget-limit.md" with { type: "text" };
import goalsGoalContinuation from "./goals/goal-continuation.md" with { type: "text" };
import goalsGoalModeActive from "./goals/goal-mode-active.md" with { type: "text" };
import goalsGoalModeContext from "./goals/goal-mode-context.md" with { type: "text" };
import goalsGoalTodoContext from "./goals/goal-todo-context.md" with { type: "text" };
import goalsGuidedGoalInterview from "./goals/guided-goal-interview.md" with { type: "text" };
import goalsGuidedGoalSystem from "./goals/guided-goal-system.md" with { type: "text" };
import memoriesConsolidation from "./memories/consolidation.md" with { type: "text" };
import memoriesConsolidationSystem from "./memories/consolidation_system.md" with { type: "text" };
import memoriesConsolidationShort from "./memories/consolidation-short.md" with { type: "text" };
import memoriesExtractionLines from "./memories/extraction-lines.md" with { type: "text" };
import memoriesReadPath from "./memories/read-path.md" with { type: "text" };
import memoriesStageOneInput from "./memories/stage_one_input.md" with { type: "text" };
import memoriesStageOneSystem from "./memories/stage_one_system.md" with { type: "text" };
import planModeActive from "./plan-mode/active.md" with { type: "text" };
import planModeApproved from "./plan-mode/approved.md" with { type: "text" };
import planModeCompactInstructions from "./plan-mode/compact-instructions.md" with { type: "text" };
import planModeReference from "./plan-mode/reference.md" with { type: "text" };
import planModeSubagent from "./plan-mode/subagent.md" with { type: "text" };
import planModeToolDecisionReminder from "./plan-mode/tool-decision-reminder.md" with { type: "text" };
import planModeYoloHandoff from "./plan-mode/yolo-handoff.md" with { type: "text" };
import requestsCiGreen from "./requests/ci-green.md" with { type: "text" };
import requestsReview from "./requests/review.md" with { type: "text" };
import requestsReviewCustom from "./requests/review-custom.md" with { type: "text" };
import requestsReviewHeadless from "./requests/review-headless.md" with { type: "text" };
import rulesTtsrInterrupt from "./rules/ttsr-interrupt.md" with { type: "text" };
import rulesTtsrToolReminder from "./rules/ttsr-tool-reminder.md" with { type: "text" };
import sessionCustomSystemPrompt from "./session/custom-system-prompt.md" with { type: "text" };
import sessionPersonalitiesDefault from "./session/personalities/default.md" with { type: "text" };
import sessionPersonalitiesFriendly from "./session/personalities/friendly.md" with { type: "text" };
import sessionPersonalitiesPragmatic from "./session/personalities/pragmatic.md" with { type: "text" };
import sessionProjectPrompt from "./session/project-prompt.md" with { type: "text" };
import sessionSystemPrompt from "./session/system-prompt.md" with { type: "text" };
import sessionVibeModeActive from "./session/vibe-mode-active.md" with { type: "text" };
import sideChannelBackgroundTanDispatch from "./side-channel/background-tan-dispatch.md" with { type: "text" };
import sideChannelBtwUser from "./side-channel/btw-user.md" with { type: "text" };
import sideChannelIrcAutoreply from "./side-channel/irc-autoreply.md" with { type: "text" };
import sideChannelIrcIncoming from "./side-channel/irc-incoming.md" with { type: "text" };
import sideChannelOmfgUser from "./side-channel/omfg-user.md" with { type: "text" };
import sideChannelRecapUser from "./side-channel/recap-user.md" with { type: "text" };
import sideChannelSideChannelNoTools from "./side-channel/side-channel-no-tools.md" with { type: "text" };
import sideChannelSpeechRewrite from "./side-channel/speech-rewrite.md" with { type: "text" };
import sideChannelTanContextSwitch from "./side-channel/tan-context-switch.md" with { type: "text" };
import skillsAutoload from "./skills/autoload.md" with { type: "text" };
import skillsUserInvocation from "./skills/user-invocation.md" with { type: "text" };
import steeringParentIrc from "./steering/parent-irc.md" with { type: "text" };
import steeringUserInterjection from "./steering/user-interjection.md" with { type: "text" };
import subagentAgentCreationArchitect from "./subagent/agent-creation-architect.md" with { type: "text" };
import subagentAgentCreationUser from "./subagent/agent-creation-user.md" with { type: "text" };
import subagentOrchestrateNotice from "./subagent/orchestrate-notice.md" with { type: "text" };
import subagentSystemPrompt from "./subagent/system-prompt.md" with { type: "text" };
import subagentTaskLabel from "./subagent/task-label.md" with { type: "text" };
import subagentUserPrompt from "./subagent/user-prompt.md" with { type: "text" };
import subagentWorkflowNotice from "./subagent/workflow-notice.md" with { type: "text" };
import subagentYieldReminder from "./subagent/yield-reminder.md" with { type: "text" };
import thinkingDifficulty from "./thinking/difficulty.md" with { type: "text" };
import thinkingDifficultyLocal from "./thinking/difficulty-local.md" with { type: "text" };
import titlesMarkerInstruction from "./titles/marker-instruction.md" with { type: "text" };
import titlesSystem from "./titles/system.md" with { type: "text" };
import toolsApplyPatch from "./tools/apply-patch.md" with { type: "text" };
import toolsAsk from "./tools/ask.md" with { type: "text" };
import toolsAstEdit from "./tools/ast-edit.md" with { type: "text" };
import toolsAstGrep from "./tools/ast-grep.md" with { type: "text" };
import toolsAsyncResult from "./tools/async-result.md" with { type: "text" };
import toolsBash from "./tools/bash.md" with { type: "text" };
import toolsBrowser from "./tools/browser.md" with { type: "text" };
import toolsCheckpoint from "./tools/checkpoint.md" with { type: "text" };
import toolsDebug from "./tools/debug.md" with { type: "text" };
import toolsEval from "./tools/eval.md" with { type: "text" };
import toolsGithub from "./tools/github.md" with { type: "text" };
import toolsGlob from "./tools/glob.md" with { type: "text" };
import toolsGoal from "./tools/goal.md" with { type: "text" };
import toolsGrep from "./tools/grep.md" with { type: "text" };
import toolsImageAttachmentDescribe from "./tools/image-attachment-describe.md" with { type: "text" };
import toolsImageAttachmentDescribeSystem from "./tools/image-attachment-describe-system.md" with { type: "text" };
import toolsImageGen from "./tools/image-gen.md" with { type: "text" };
import toolsInspectImage from "./tools/inspect-image.md" with { type: "text" };
import toolsInspectImageSystem from "./tools/inspect-image-system.md" with { type: "text" };
import toolsIrc from "./tools/irc.md" with { type: "text" };
import toolsJob from "./tools/job.md" with { type: "text" };
import toolsLaunch from "./tools/launch.md" with { type: "text" };
import toolsLearn from "./tools/learn.md" with { type: "text" };
import toolsLsp from "./tools/lsp.md" with { type: "text" };
import toolsLspLateDiagnostic from "./tools/lsp-late-diagnostic.md" with { type: "text" };
import toolsManageSkill from "./tools/manage-skill.md" with { type: "text" };
import toolsMemoryEdit from "./tools/memory-edit.md" with { type: "text" };
import toolsPatch from "./tools/patch.md" with { type: "text" };
import toolsRead from "./tools/read.md" with { type: "text" };
import toolsRecall from "./tools/recall.md" with { type: "text" };
import toolsReflect from "./tools/reflect.md" with { type: "text" };
import toolsReplace from "./tools/replace.md" with { type: "text" };
import toolsResolve from "./tools/resolve.md" with { type: "text" };
import toolsRetain from "./tools/retain.md" with { type: "text" };
import toolsRewind from "./tools/rewind.md" with { type: "text" };
import toolsSearchToolBm25 from "./tools/search-tool-bm25.md" with { type: "text" };
import toolsSetCwd from "./tools/set-cwd.md" with { type: "text" };
import toolsSsh from "./tools/ssh.md" with { type: "text" };
import toolsTask from "./tools/task.md" with { type: "text" };
import toolsTaskSummary from "./tools/task-summary.md" with { type: "text" };
import toolsTodo from "./tools/todo.md" with { type: "text" };
import toolsVibeKill from "./tools/vibe-kill.md" with { type: "text" };
import toolsVibeList from "./tools/vibe-list.md" with { type: "text" };
import toolsVibeSend from "./tools/vibe-send.md" with { type: "text" };
import toolsVibeSpawn from "./tools/vibe-spawn.md" with { type: "text" };
import toolsVibeTurnResult from "./tools/vibe-turn-result.md" with { type: "text" };
import toolsVibeWait from "./tools/vibe-wait.md" with { type: "text" };
import toolsWebSearch from "./tools/web-search.md" with { type: "text" };
import toolsWebSearchSystem from "./tools/web-search-system.md" with { type: "text" };
import toolsWrite from "./tools/write.md" with { type: "text" };
import turnControlAutoContinue from "./turn-control/auto-continue.md" with { type: "text" };
import turnControlEagerTask from "./turn-control/eager-task.md" with { type: "text" };
import turnControlEagerTodo from "./turn-control/eager-todo.md" with { type: "text" };
import turnControlEmptyStopRetry from "./turn-control/empty-stop-retry.md" with { type: "text" };
import turnControlGeminiToolCallReminder from "./turn-control/gemini-tool-call-reminder.md" with { type: "text" };
import turnControlInterruptedThinking from "./turn-control/interrupted-thinking.md" with { type: "text" };
import turnControlManualContinue from "./turn-control/manual-continue.md" with { type: "text" };
import turnControlMidRunTodoNudge from "./turn-control/mid-run-todo-nudge.md" with { type: "text" };
import turnControlPrewalkChecklist from "./turn-control/prewalk-checklist.md" with { type: "text" };
import turnControlPrewalkContinue from "./turn-control/prewalk-continue.md" with { type: "text" };
import turnControlPrewalkPlan from "./turn-control/prewalk-plan.md" with { type: "text" };
import turnControlRewindReport from "./turn-control/rewind-report.md" with { type: "text" };
import turnControlThinkingLoopRedirect from "./turn-control/thinking-loop-redirect.md" with { type: "text" };
import turnControlToolCallLoopRedirect from "./turn-control/tool-call-loop-redirect.md" with { type: "text" };
import turnControlUltrathinkNotice from "./turn-control/ultrathink-notice.md" with { type: "text" };
import turnControlUnexpectedStopClassifier from "./turn-control/unexpected-stop-classifier.md" with { type: "text" };
import turnControlUnexpectedStopRetry from "./turn-control/unexpected-stop-retry.md" with { type: "text" };

/**
 * A banner-delimited region of a prompt.
 *
 * Recorded so a prompt can be inspected and overridden by region rather than
 * whole. The shape is {@link BanneredSection} rather than a fourth field list:
 * this interface and the system prompt's own were separate declarations of one
 * concept, both exported as `PromptSection` from sibling modules, and a reader
 * importing "the" `PromptSection` got whichever one their editor offered. They
 * had also each grown a field the other lacked.
 *
 * The alias survives because the name is the right one at this call site and 160
 * prompts are addressed through this file; what does not survive is a second
 * place that decides what a section HAS.
 */
export type PromptSection = BanneredSection;

/** One prompt: its text, what it is for, and how it divides. */
export interface PromptEntry {
	readonly text: string;
	/** One line on what this prompt does, so the registry reads as a list rather than a directory. */
	readonly purpose: string;
	/** Present only where a prompt has addressable regions; absent means one undivided body. */
	readonly sections?: readonly PromptSection[];
}

/**
 * Every prompt, by id. The id is the file's path under `src/prompts/` without
 * its extension, so a row and its file are found from each other by reading.
 */
export const PROMPTS = {
	"advisor/active-repo-watchdog": {
		text: advisorActiveRepoWatchdog,
		purpose: "extra advisor attention when the session cwd sits outside the one child git repo",
	},
	"advisor/advise-tool": { text: advisorAdviseTool, purpose: "the `advise` tool description the advisor sees" },
	"advisor/context-files": {
		text: advisorContextFiles,
		purpose: "hands the advisor the project's standing instruction files",
	},
	"advisor/system": { text: advisorSystem, purpose: "the background advisor watching a live session" },
	"agents/designer": { text: agentsDesigner, purpose: "the bundled designer agent definition" },
	"agents/frontmatter": { text: agentsFrontmatter, purpose: "renders an agent definition back out as frontmatter" },
	"agents/init": { text: agentsInit, purpose: "the bundled init agent that writes AGENTS.md" },
	"agents/librarian": { text: agentsLibrarian, purpose: "the bundled librarian agent definition" },
	"agents/reviewer": { text: agentsReviewer, purpose: "the bundled reviewer agent definition" },
	"agents/scout": { text: agentsScout, purpose: "the bundled scout agent definition" },
	"agents/task": { text: agentsTask, purpose: "the bundled general worker agent definition" },
	"autolearn/guidance": { text: autolearnGuidance, purpose: "explains managed skills and when to mint one" },
	"autolearn/guidance-learn": {
		text: autolearnGuidanceLearn,
		purpose: "the autolearn block covering the `learn` tool",
	},
	"autolearn/nudge-autocontinue": {
		text: autolearnNudgeAutocontinue,
		purpose: "an automated capture turn that must not be read as a user reply",
	},
	"autoresearch/command-resume": {
		text: autoresearchCommandResume,
		purpose: "resumes autoresearch on the active session",
	},
	"autoresearch/prompt": {
		text: autoresearchPrompt,
		purpose: "the autoresearch run prompt, wrapping the base system prompt",
	},
	"autoresearch/prompt-setup": {
		text: autoresearchPromptSetup,
		purpose: "the autoresearch setup prompt, before an experiment exists",
	},
	"autoresearch/resume-message": {
		text: autoresearchResumeMessage,
		purpose: "the steer that continues the autoresearch loop",
	},
	"bench/balance": {
		text: benchBalance,
		purpose: "a fixed short generation request used to warm and compare provider balance",
	},
	"bench/throughput": {
		text: benchThroughput,
		purpose: "a fixed long-form generation request used to benchmark throughput",
	},
	"commit-agentic/analyze-file": {
		text: commitAgenticAnalyzeFile,
		purpose: "asks the agentic commit flow's model to analyze one file",
	},
	"commit-agentic/session-user": {
		text: commitAgenticSessionUser,
		purpose: "opens the agentic commit flow over the staged changes",
	},
	"commit-agentic/split-confirm": {
		text: commitAgenticSplitConfirm,
		purpose: "asks the operator to confirm a multi-commit split",
	},
	"commit-agentic/system": { text: commitAgenticSystem, purpose: "drives the agentic commit flow" },
	"commit/analysis-system": {
		text: commitAnalysisSystem,
		purpose: "classifies a diff into conventional-commit terms",
	},
	"commit/analysis-user": {
		text: commitAnalysisUser,
		purpose: "the analysis task, carrying the diff and project context",
	},
	"commit/changelog-system": { text: commitChangelogSystem, purpose: "writes changelog entries from commits" },
	"commit/changelog-user": {
		text: commitChangelogUser,
		purpose: "the changelog task, carrying the target file and existing entries",
	},
	"commit/file-observer-system": {
		text: commitFileObserverSystem,
		purpose: "the map phase: describes one changed file",
	},
	"commit/file-observer-user": { text: commitFileObserverUser, purpose: "the map task, carrying one file's diff" },
	"commit/message-system": { text: commitMessageSystem, purpose: "writes a commit message for the non-agentic path" },
	"commit/reduce-system": {
		text: commitReduceSystem,
		purpose: "the reduce phase: folds per-file descriptions into one message",
	},
	"commit/reduce-user": {
		text: commitReduceUser,
		purpose: "the reduce task, carrying the observations and diff statistics",
	},
	"commit/summary-retry": {
		text: commitSummaryRetry,
		purpose: "re-asks for a summary after validation rejected the last one",
	},
	"commit/summary-system": {
		text: commitSummarySystem,
		purpose: "writes the description half of a conventional commit",
	},
	"commit/summary-user": {
		text: commitSummaryUser,
		purpose: "the summary task, carrying the detail points and diff statistics",
	},
	"commit/types-description": {
		text: commitTypesDescription,
		purpose: "the conventional-commit type list shared by the commit prompts",
	},
	"goals/goal-budget-limit": {
		text: goalsGoalBudgetLimit,
		purpose: "tells the agent the active goal hit its token budget",
	},
	"goals/goal-continuation": {
		text: goalsGoalContinuation,
		purpose: "the hidden steer that resumes an autonomous goal",
	},
	"goals/goal-mode-active": {
		text: goalsGoalModeActive,
		purpose: "the goal-mode context block carrying objective and budget",
	},
	"goals/goal-mode-context": { text: goalsGoalModeContext, purpose: "composes the goal block with its todo block" },
	"goals/goal-todo-context": {
		text: goalsGoalTodoContext,
		purpose: "the persisted todo state a goal continuation gets instead of a user nudge",
	},
	"goals/guided-goal-interview": {
		text: goalsGuidedGoalInterview,
		purpose: "turns a setup interview transcript into one objective",
	},
	"goals/guided-goal-system": { text: goalsGuidedGoalSystem, purpose: "walks a user through defining a goal" },
	"memories/consolidation": {
		text: memoriesConsolidation,
		purpose: "the stage-two consolidation task, with the raw corpus inlined",
	},
	"memories/consolidation-short": {
		text: memoriesConsolidationShort,
		purpose: "condenses stored memories into a few sentences",
	},
	"memories/consolidation_system": {
		text: memoriesConsolidationSystem,
		purpose: "merges extracted memories into the stored set",
	},
	"memories/extraction-lines": {
		text: memoriesExtractionLines,
		purpose: "extracts durable memory items from one user message",
	},
	"memories/read-path": { text: memoriesReadPath, purpose: "tells the agent how to read the memory root" },
	"memories/stage_one_input": {
		text: memoriesStageOneInput,
		purpose: "the stage-one extraction task, with the rollout items inlined",
	},
	"memories/stage_one_system": { text: memoriesStageOneSystem, purpose: "extracts candidate memories from a session" },
	"plan-mode/active": { text: planModeActive, purpose: "the read-only contract while plan mode is on" },
	"plan-mode/approved": { text: planModeApproved, purpose: "hands over an approved plan for execution" },
	"plan-mode/compact-instructions": {
		text: planModeCompactInstructions,
		purpose: "distills the plan-mode discussion before execution",
	},
	"plan-mode/reference": { text: planModeReference, purpose: "points a later turn back at the approved plan file" },
	"plan-mode/subagent": {
		text: planModeSubagent,
		purpose: "the prompt a subagent runs under while plan mode is active",
	},
	"plan-mode/tool-decision-reminder": {
		text: planModeToolDecisionReminder,
		purpose: "forces a next action when a plan-mode turn ended without one",
	},
	"plan-mode/yolo-handoff": {
		text: planModeYoloHandoff,
		purpose: "hands an approved plan to an agent that did not draft it",
	},
	"requests/ci-green": { text: requestsCiGreen, purpose: "drives a session to keep working until branch CI is green" },
	"requests/review": { text: requestsReview, purpose: "a code review over a concrete changed-file set" },
	"requests/review-custom": {
		text: requestsReviewCustom,
		purpose: "a code review run under caller-supplied instructions",
	},
	"requests/review-headless": {
		text: requestsReviewHeadless,
		purpose: "a code review run with no interactive operator",
	},
	"rules/ttsr-interrupt": { text: rulesTtsrInterrupt, purpose: "interrupts output that violated a user-defined rule" },
	"rules/ttsr-tool-reminder": {
		text: rulesTtsrToolReminder,
		purpose: "reports a rule that matched a tool call without interrupting it",
	},
	"session/custom-system-prompt": {
		text: sessionCustomSystemPrompt,
		purpose: "assembles an operator-supplied system prompt with its context files",
	},
	"session/personalities/default": {
		text: sessionPersonalitiesDefault,
		purpose: "the terse evidence-first personality",
	},
	"session/personalities/friendly": {
		text: sessionPersonalitiesFriendly,
		purpose: "the warm collaborative personality",
	},
	"session/personalities/pragmatic": {
		text: sessionPersonalitiesPragmatic,
		purpose: "the pragmatic senior-engineer personality",
	},
	"session/project-prompt": { text: sessionProjectPrompt, purpose: "the workstation and project context block" },
	"session/system-prompt": { text: sessionSystemPrompt, purpose: "the main system prompt" },
	"session/vibe-mode-active": { text: sessionVibeModeActive, purpose: "the director contract while vibe mode is on" },
	"side-channel/background-tan-dispatch": {
		text: sideChannelBackgroundTanDispatch,
		purpose: "notifies the agent that a tangential task moved to a background agent",
	},
	"side-channel/btw-user": {
		text: sideChannelBtwUser,
		purpose: "an ephemeral side question answered from context with no tools",
	},
	"side-channel/irc-autoreply": {
		text: sideChannelIrcAutoreply,
		purpose: "a side-channel turn replying to an IRC message mid-task",
	},
	"side-channel/irc-incoming": {
		text: sideChannelIrcIncoming,
		purpose: "delivers an incoming IRC message from another agent",
	},
	"side-channel/omfg-user": {
		text: sideChannelOmfgUser,
		purpose: "authors a Time Traveling Stream Rule from a frustrating behavior",
	},
	"side-channel/recap-user": { text: sideChannelRecapUser, purpose: "recaps the session for a user who stepped away" },
	"side-channel/side-channel-no-tools": {
		text: sideChannelSideChannelNoTools,
		purpose: "an ephemeral turn that reuses context but forbids tool calls",
	},
	"side-channel/speech-rewrite": {
		text: sideChannelSpeechRewrite,
		purpose: "rewrites assistant text for speech synthesis",
	},
	"side-channel/tan-context-switch": {
		text: sideChannelTanContextSwitch,
		purpose: "tells a forked session it owns only the new request",
	},
	"skills/autoload": { text: skillsAutoload, purpose: "wraps a skill body that was loaded automatically" },
	"skills/user-invocation": { text: skillsUserInvocation, purpose: "wraps a skill body the user invoked by name" },
	"steering/parent-irc": {
		text: steeringParentIrc,
		purpose: "delivers a parent agent's IRC message that broke an interruptible wait",
	},
	"steering/user-interjection": {
		text: steeringUserInterjection,
		purpose: "delivers a user message that arrived mid-turn and takes priority",
	},
	"subagent/agent-creation-architect": {
		text: subagentAgentCreationArchitect,
		purpose: "designs a new agent definition from a description",
	},
	"subagent/agent-creation-user": {
		text: subagentAgentCreationUser,
		purpose: "the user half of agent creation, carrying the request",
	},
	"subagent/orchestrate-notice": {
		text: subagentOrchestrateNotice,
		purpose: "recasts the user's message as an orchestration contract",
	},
	"subagent/system-prompt": {
		text: subagentSystemPrompt,
		purpose: "the system prompt a delegated task runs under",
		sections: [
			{ id: "role", name: "ROLE", purpose: "the agent definition the caller selected", optional: false },
			{
				id: "context",
				name: "CONTEXT",
				purpose: "caller-supplied context for this assignment",
				optional: true,
			},
			{ id: "plan", name: "PLAN", purpose: "the approved plan this assignment is part of", optional: true },
			{
				id: "coop",
				name: "COOP",
				purpose: "working-tree isolation and IRC peer coordination",
				optional: false,
			},
			{
				id: "completion",
				name: "COMPLETION",
				purpose: "yield protocol, output schema, and the no-giving-up contract",
				optional: false,
			},
		],
	},
	"subagent/task-label": { text: subagentTaskLabel, purpose: "labels a delegated assignment in one short sentence" },
	"subagent/user-prompt": {
		text: subagentUserPrompt,
		purpose: "the user half of a delegated task, carrying the assignment",
	},
	"subagent/workflow-notice": {
		text: subagentWorkflowNotice,
		purpose: "recasts the user's message as a deterministic multi-subagent workflow",
	},
	"subagent/yield-reminder": {
		text: subagentYieldReminder,
		purpose: "forces a subagent to yield when its budget or turn limit is spent",
	},
	"thinking/difficulty": { text: thinkingDifficulty, purpose: "classifies how much thinking a turn needs" },
	"thinking/difficulty-local": {
		text: thinkingDifficultyLocal,
		purpose: "classifies request difficulty for a local classifier model",
	},
	"titles/marker-instruction": {
		text: titlesMarkerInstruction,
		purpose: "the shared output contract for title generation",
	},
	"titles/system": { text: titlesSystem, purpose: "names a new session from its opening turn" },
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
	"turn-control/auto-continue": {
		text: turnControlAutoContinue,
		purpose: "resumes the user's most recent intent after compaction",
	},
	"turn-control/eager-task": {
		text: turnControlEagerTask,
		purpose: "the delegation block telling the agent subagents are the default",
	},
	"turn-control/eager-todo": { text: turnControlEagerTodo, purpose: "requires a phased todo before substantive work" },
	"turn-control/empty-stop-retry": {
		text: turnControlEmptyStopRetry,
		purpose: "restarts a turn that ended without doing anything",
	},
	"turn-control/gemini-tool-call-reminder": {
		text: turnControlGeminiToolCallReminder,
		purpose: "interrupts reasoning that produced planning headers and no tool call",
	},
	"turn-control/interrupted-thinking": {
		text: turnControlInterruptedThinking,
		purpose: "hands back reasoning preserved from an interrupted turn",
	},
	"turn-control/manual-continue": { text: turnControlManualContinue, purpose: "the operator's explicit continue" },
	"turn-control/mid-run-todo-nudge": {
		text: turnControlMidRunTodoNudge,
		purpose: "reminds the agent that todo items are still open",
	},
	"turn-control/prewalk-checklist": {
		text: turnControlPrewalkChecklist,
		purpose: "the finish-line checklist before a task is called done",
	},
	"turn-control/prewalk-continue": { text: turnControlPrewalkContinue, purpose: "refuses to let the turn end here" },
	"turn-control/prewalk-plan": {
		text: turnControlPrewalkPlan,
		purpose: "demands the complete plan in the next reply",
	},
	"turn-control/rewind-report": {
		text: turnControlRewindReport,
		purpose: "replaces rewound exploration with its retained report",
	},
	"turn-control/thinking-loop-redirect": {
		text: turnControlThinkingLoopRedirect,
		purpose: "interrupts a turn whose reasoning stopped making progress",
	},
	"turn-control/tool-call-loop-redirect": {
		text: turnControlToolCallLoopRedirect,
		purpose: "interrupts repeated identical tool calls",
	},
	"turn-control/ultrathink-notice": {
		text: turnControlUltrathinkNotice,
		purpose: "raises reasoning effort for a multi-step request",
	},
	"turn-control/unexpected-stop-classifier": {
		text: turnControlUnexpectedStopClassifier,
		purpose: "decides whether an assistant turn stopped short of what it promised",
	},
	"turn-control/unexpected-stop-retry": {
		text: turnControlUnexpectedStopRetry,
		purpose: "restarts a turn that promised an action and stopped",
	},
} as const satisfies Record<string, PromptEntry>;

/** The id of a registered prompt. A value outside this union is a compile error. */
export type PromptId = keyof typeof PROMPTS;

/** Every registered id, for enumeration (inspection commands, coverage checks). */
export const PROMPT_IDS = Object.keys(PROMPTS) as PromptId[];

/**
 * The text of a registered prompt.
 *
 * `PROMPTS[id].text` is equivalent and preferred at a call site that already
 * knows its id literally. This exists for the paths that carry an id in a
 * variable, where the indexed form would otherwise widen to `string`.
 */
export function promptText(id: PromptId): string {
	return PROMPTS[id].text;
}

/**
 * A prompt looked up by an id that is not statically known.
 *
 * Throws rather than returning undefined: an unknown id degrading to a missing
 * prompt means the model silently receives nothing where instructions belonged,
 * which reads downstream as the model ignoring its brief.
 */
export function requirePrompt(id: string): PromptEntry {
	const found = (PROMPTS as Record<string, PromptEntry>)[id];
	if (found) return found;
	throw new Error(`unknown prompt "${id}"; ids are the path under src/prompts without .md`);
}
