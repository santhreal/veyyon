/**
 * What the agent domain contributes.
 *
 * The tools whose subject is the run itself rather than the machine: asking the user, the todo
 * board, memory, peer messaging, skills, the vibe fleet, and the hidden four a host constructs
 * without advertising — the yield that ends a turn, the finding report, the tool-issue report and
 * the pending-action resolve.
 *
 * The factories stay dynamic for the reason the whole dispatch table does, and this file is one of
 * the six the dynamic-import baseline names for it.
 */
import type { ToolDomainManifest } from "@veyyon/kernel/registry/tool-domain";
import { ARGOT_LOAD_TOOL, ARGOT_UNLOAD_TOOL } from "argot/constants";
import type { BuiltinToolName, HiddenToolName } from "../core/builtin-names";
import type { ToolFactory } from "../index";

export const agentTools = {
	ask: async s => (await import("./ask")).AskTool.createIf(s),
	irc: async s => (await import("./irc")).IrcTool.createIf(s),
	todo: async s => new (await import("./todo")).TodoTool(s),
	memory_edit: async s => (await import("./memory-edit")).MemoryEditTool.createIf(s),
	retain: async s => (await import("./memory-retain")).MemoryRetainTool.createIf(s),
	recall: async s => (await import("./memory-recall")).MemoryRecallTool.createIf(s),
	reflect: async s => (await import("./memory-reflect")).MemoryReflectTool.createIf(s),
	learn: async s => (await import("./learn")).LearnTool.createIf(s),
	manage_skill: async s => (await import("./manage-skill")).ManageSkillTool.createIf(s),
	// The two Argot folder tools exist only when the session holds a codec; with
	// the feature off, or for a subagent under `argot.subagents: off`, there is no
	// session to load into, so the factory returns null and the tool is absent.
	[ARGOT_LOAD_TOOL]: async s =>
		s.settings.get("argot.enabled") && s.getArgotSession?.() !== undefined
			? new (await import("./argot")).ArgotLoadTool(s)
			: null,
	[ARGOT_UNLOAD_TOOL]: async s =>
		s.settings.get("argot.enabled") && s.getArgotSession?.() !== undefined
			? new (await import("./argot")).ArgotUnloadTool(s)
			: null,
} satisfies Partial<Record<BuiltinToolName, ToolFactory>>;

export const agentHiddenTools = {
	yield: async s => new (await import("./yield")).YieldTool(s),
	report_finding: async () => (await import("./review")).reportFindingTool,
	report_tool_issue: async s => (await import("./report-tool-issue")).createReportToolIssueTool(s),
	resolve: async s => new (await import("./resolve")).ResolveTool(s),
} satisfies Partial<Record<HiddenToolName, ToolFactory>>;

export const agentDomain = {
	domain: "agent",
	tools: agentTools,
	hidden: agentHiddenTools,
} satisfies ToolDomainManifest<ToolFactory>;
