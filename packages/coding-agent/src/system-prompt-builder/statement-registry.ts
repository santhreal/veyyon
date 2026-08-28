import { isRecord } from "@veyyon/utils";
import { assertNoRegisteredBanners, bannerTable, renderBanner } from "./banner-grammar";
import { SYSTEM_PROMPT_SECTIONS, TEMPLATE_SECTION_IDS } from "./section-registry";

import statementConventions from "./statements/conventions/conventions.md" with { type: "text" };
import statementDeliveryCompleteness from "./statements/delivery-contract/completeness.md" with { type: "text" };
import statementDeliveryContract from "./statements/delivery-contract/contract.md" with { type: "text" };
import statementDeliveryCritical from "./statements/delivery-contract/critical.md" with { type: "text" };
import statementDeliveryEvidenceAndOutput from "./statements/delivery-contract/evidence-and-output.md" with {
	type: "text",
};
import statementDeliveryNeverStopEarly from "./statements/delivery-contract/never-stop-early.md" with { type: "text" };
import statementDeliveryNoPartialYield from "./statements/delivery-contract/no-partial-yield.md" with { type: "text" };
import statementDeliveryNoPunting from "./statements/delivery-contract/no-punting.md" with { type: "text" };
import statementDeliveryPersonality from "./statements/delivery-contract/personality.md" with { type: "text" };
import statementDeliveryVerificationSource from "./statements/delivery-contract/verification-source.md" with {
	type: "text",
};
import statementDeliveryYielding from "./statements/delivery-contract/yielding.md" with { type: "text" };
import statementExecutionCleanup from "./statements/execution-workflow/cleanup.md" with { type: "text" };
import statementExecutionDecompose from "./statements/execution-workflow/decompose.md" with { type: "text" };
import statementExecutionDecomposeTodoBatching from "./statements/execution-workflow/decompose-todo-batching.md" with {
	type: "text",
};
import statementExecutionImplement from "./statements/execution-workflow/implement.md" with { type: "text" };
import statementExecutionImplementAskFirst from "./statements/execution-workflow/implement-ask-first.md" with {
	type: "text",
};
import statementExecutionImplementGrep from "./statements/execution-workflow/implement-grep.md" with { type: "text" };
import statementExecutionImplementNoDestructive from "./statements/execution-workflow/implement-no-destructive.md" with {
	type: "text",
};
import statementExecutionReadRulesOnly from "./statements/execution-workflow/read-rules-only.md" with { type: "text" };
import statementExecutionReadSkillsAndRules from "./statements/execution-workflow/read-skills-and-rules.md" with {
	type: "text",
};
import statementExecutionReadSkillsOnly from "./statements/execution-workflow/read-skills-only.md" with {
	type: "text",
};
import statementExecutionResearch from "./statements/execution-workflow/research.md" with { type: "text" };
import statementExecutionResearchLspReferences from "./statements/execution-workflow/research-lsp-references.md" with {
	type: "text",
};
import statementExecutionResearchReread from "./statements/execution-workflow/research-reread.md" with { type: "text" };
import statementExecutionScope from "./statements/execution-workflow/scope.md" with { type: "text" };
import statementExecutionScopePlanFirst from "./statements/execution-workflow/scope-plan-first.md" with {
	type: "text",
};
import statementExecutionVerify from "./statements/execution-workflow/verify.md" with { type: "text" };
import statementExecutionVerifyBrowser from "./statements/execution-workflow/verify-browser.md" with { type: "text" };
import statementRoleMermaid from "./statements/role/mermaid-diagrams.md" with { type: "text" };
import statementRolePrinciples from "./statements/role/principles.md" with { type: "text" };
import statementRuntimeAlwaysApplyRules from "./statements/runtime/always-apply-rules.md" with { type: "text" };
import statementRuntimeDomainRules from "./statements/runtime/domain-rules.md" with { type: "text" };
import statementRuntimeUrlsAgents from "./statements/runtime/internal-urls-agents.md" with { type: "text" };
import statementRuntimeUrlsHead from "./statements/runtime/internal-urls-head.md" with { type: "text" };
import statementRuntimeUrlsTail from "./statements/runtime/internal-urls-tail.md" with { type: "text" };
import statementRuntimeMcpDiscovery from "./statements/runtime/mcp-discovery-notice.md" with { type: "text" };
import statementRuntimeMcpDiscoverySearch from "./statements/runtime/mcp-discovery-search.md" with { type: "text" };
import statementRuntimeMcpDiscoveryServers from "./statements/runtime/mcp-discovery-servers.md" with { type: "text" };
import statementRuntimeMemoryUrl from "./statements/runtime/memory-root-url.md" with { type: "text" };
import statementRuntimeObsidianUrl from "./statements/runtime/obsidian-vault-url.md" with { type: "text" };
import statementRuntimeSkills from "./statements/runtime/skills.md" with { type: "text" };
import statementRuntimeSkillsHeading from "./statements/runtime/skills-rules-heading.md" with { type: "text" };
import statementRuntimeInventoryText from "./statements/runtime/tool-inventory-text.md" with { type: "text" };
import statementToolPolicyAst from "./statements/tool-policy/ast.md" with { type: "text" };
import statementToolPolicyAstEdit from "./statements/tool-policy/ast-edit.md" with { type: "text" };
import statementToolPolicyAstGrep from "./statements/tool-policy/ast-grep.md" with { type: "text" };
import statementToolPolicyAstPlainText from "./statements/tool-policy/ast-plain-text.md" with { type: "text" };
import statementToolPolicyBashCwd from "./statements/tool-policy/bash-cwd.md" with { type: "text" };
import statementToolPolicyDelegation from "./statements/tool-policy/delegation.md" with { type: "text" };
import statementToolPolicyDelegationAllowed from "./statements/tool-policy/delegation-allowed.md" with { type: "text" };
import statementToolPolicyDelegationCodexEager from "./statements/tool-policy/delegation-codex-eager.md" with {
	type: "text",
};
import statementToolPolicyDelegationCodexOff from "./statements/tool-policy/delegation-codex-off.md" with {
	type: "text",
};
import statementToolPolicyDelegationConcurrencyCap from "./statements/tool-policy/delegation-concurrency-cap.md" with {
	type: "text",
};
import statementToolPolicyDelegationGates from "./statements/tool-policy/delegation-gates.md" with { type: "text" };
import statementToolPolicyDelegationNoShrinking from "./statements/tool-policy/delegation-no-shrinking.md" with {
	type: "text",
};
import statementToolPolicyDelegationPreferred from "./statements/tool-policy/delegation-preferred.md" with {
	type: "text",
};
import statementToolPolicyDelegationRequired from "./statements/tool-policy/delegation-required.md" with {
	type: "text",
};
import statementToolPolicyDelegationSubagentValue from "./statements/tool-policy/delegation-subagent-value.md" with {
	type: "text",
};
import statementToolPolicyExploration from "./statements/tool-policy/exploration.md" with { type: "text" };
import statementToolPolicyExplorationGlob from "./statements/tool-policy/exploration-glob.md" with { type: "text" };
import statementToolPolicyExplorationGrep from "./statements/tool-policy/exploration-grep.md" with { type: "text" };
import statementToolPolicyExplorationRead from "./statements/tool-policy/exploration-read.md" with { type: "text" };
import statementToolPolicyGeneral from "./statements/tool-policy/general.md" with { type: "text" };
import statementToolPolicyInspectImage from "./statements/tool-policy/inspect-image.md" with { type: "text" };
import statementToolPolicyIntentField from "./statements/tool-policy/intent-field.md" with { type: "text" };
import statementToolPolicyLsp from "./statements/tool-policy/lsp.md" with { type: "text" };
import statementToolPolicyParallelMeansSubagents from "./statements/tool-policy/parallel-means-subagents.md" with {
	type: "text",
};
import statementToolPolicyReportToolIssue from "./statements/tool-policy/report-tool-issue.md" with { type: "text" };
import statementToolPolicyResultContract from "./statements/tool-policy/result-contract.md" with { type: "text" };
import statementToolPolicySecretsRedaction from "./statements/tool-policy/secrets-redaction.md" with { type: "text" };
import statementToolPolicySpecializedBash from "./statements/tool-policy/specialized-bash.md" with { type: "text" };
import statementToolPolicySpecializedBashLitmus from "./statements/tool-policy/specialized-bash-litmus.md" with {
	type: "text",
};
import statementToolPolicySpecializedEdit from "./statements/tool-policy/specialized-edit.md" with { type: "text" };
import statementToolPolicySpecializedGlob from "./statements/tool-policy/specialized-glob.md" with { type: "text" };
import statementToolPolicySpecializedGrep from "./statements/tool-policy/specialized-grep.md" with { type: "text" };
import statementToolPolicySpecializedLsp from "./statements/tool-policy/specialized-lsp.md" with { type: "text" };
import statementToolPolicySpecializedRead from "./statements/tool-policy/specialized-read.md" with { type: "text" };
import statementToolPolicySpecializedTools from "./statements/tool-policy/specialized-tools.md" with { type: "text" };
import statementToolPolicySpecializedWrite from "./statements/tool-policy/specialized-write.md" with { type: "text" };
import statementToolPolicyToolIo from "./statements/tool-policy/tool-io.md" with { type: "text" };

const SYSTEM_SECTION_BANNERS = bannerTable(SYSTEM_PROMPT_SECTIONS);

export type StatementCondition =
	| { readonly kind: "always" }
	| { readonly kind: "when"; readonly variable: string }
	| { readonly kind: "whenContains"; readonly collection: string; readonly member: string }
	| { readonly kind: "whenAll"; readonly conditions: readonly StatementCondition[] }
	| { readonly kind: "whenAny"; readonly conditions: readonly StatementCondition[] }
	| { readonly kind: "not"; readonly condition: StatementCondition };

export function when(variable: string): StatementCondition {
	return { kind: "when", variable };
}

export function contains(collection: string, member: string): StatementCondition {
	return { kind: "whenContains", collection, member };
}

export function allOf(...conditions: readonly StatementCondition[]): StatementCondition {
	return { kind: "whenAll", conditions };
}

export function anyOf(...conditions: readonly StatementCondition[]): StatementCondition {
	return { kind: "whenAny", conditions };
}

export function not(condition: StatementCondition): StatementCondition {
	return { kind: "not", condition };
}

export const SESSION_FACT_VARIABLES: Readonly<Record<string, string>> = Object.freeze({
	skills: "the skills this session loaded, from the skill registry",
	rules: "domain rules whose globs the session matched",
	alwaysApplyRules: "rules the operator marked always-apply, so they are inlined rather than referenced",
	hasMemoryRoot: "whether the project has a memory root for `memory://root` to resolve",
	hasObsidian: "whether an Obsidian vault is attached, which is what makes `vault://` real",
	hasTools: "whether this session exposes at least one tool",
	toolInventory: "the pre-rendered inventory text, used when the tools are not listed natively",
	mcpDiscoveryMode: "whether MCP tools are discovered on demand rather than all being present",
	hasMCPDiscoveryServers: "whether any discoverable MCP server is configured, so the list is worth naming",
	toolRefs: "the resolved tool names to interpolate, so the prompt never names a tool that is not built",
	useCodexTaskPrompt:
		"whether the active model wants the Codex-style delegation wording, derived from the model rather than from a setting",
	secretsEnabled:
		"whether an obfuscator is holding secrets, so the redaction note is only shown to a session that can produce `#XXXX#` tokens",
});

export interface PromptStatement {
	readonly id: string;
	readonly section: string;
	readonly condition: StatementCondition;
	readonly text: string;
	readonly purpose: string;
}

export const PROMPT_STATEMENTS = [
	{
		id: "conventions/conventions",
		section: "conventions",
		condition: { kind: "always" },
		text: statementConventions,
		purpose:
			"the <system-conventions> preamble: RFC 2119 vocabulary and the rule that system-authored XML markers are authoritative wherever they appear",
	},
	{
		id: "role/principles",
		section: "role",
		condition: { kind: "always" },
		text: statementRolePrinciples,
		purpose:
			"who the agent is plus the five engineering principles, which are one statement because no configuration removes any of them independently",
	},
	{
		id: "role/mermaid-diagrams",
		section: "role",
		condition: { kind: "when", variable: "renderMermaid" },
		text: statementRoleMermaid,
		purpose: "tells the model it may emit a mermaid block, which is only true when the terminal renders one as ASCII",
	},
	{
		id: "runtime/skills-rules-heading",
		section: "runtime",
		condition: { kind: "always" },
		text: statementRuntimeSkillsHeading,
		purpose:
			"the `# Skills & Rules` heading, which stands whether or not any of the three blocks under it render, so it is not part of any of them",
	},
	{
		id: "runtime/skills",
		section: "runtime",
		condition: when("skills"),
		text: statementRuntimeSkills,
		purpose:
			"the must-read-the-skill instruction plus the skill table, pointless and misleading when no skill loaded",
	},
	{
		id: "runtime/always-apply-rules",
		section: "runtime",
		condition: when("alwaysApplyRules"),
		text: statementRuntimeAlwaysApplyRules,
		purpose: "inlines the rules the operator marked always-apply, rather than referencing them by `rule://`",
	},
	{
		id: "runtime/domain-rules",
		section: "runtime",
		condition: when("rules"),
		text: statementRuntimeDomainRules,
		purpose:
			"lists the domain rules whose globs this session matched, with the globs so the model can tell when one applies",
	},
	{
		id: "runtime/internal-urls-head",
		section: "runtime",
		condition: { kind: "always" },
		text: statementRuntimeUrlsHead,
		purpose: "opens the internal-URL table with the two schemes every session has, `skill://` and `rule://`",
	},
	{
		id: "runtime/memory-root-url",
		section: "runtime",
		condition: when("hasMemoryRoot"),
		text: statementRuntimeMemoryUrl,
		purpose:
			"names `memory://root` only when the project has one, because a URL scheme the session cannot resolve is an instruction to fail",
	},
	{
		id: "runtime/internal-urls-agents",
		section: "runtime",
		condition: { kind: "always" },
		text: statementRuntimeUrlsAgents,
		purpose:
			"the agent, history, artifact and local schemes, which exist in every session because the harness provides them",
	},
	{
		id: "runtime/obsidian-vault-url",
		section: "runtime",
		condition: when("hasObsidian"),
		text: statementRuntimeObsidianUrl,
		purpose: "the `vault://` scheme and its query operations, real only when a vault is actually attached",
	},
	{
		id: "runtime/internal-urls-tail",
		section: "runtime",
		condition: { kind: "always" },
		text: statementRuntimeUrlsTail,
		purpose:
			"closes the table with the MCP, issue, PR and harness-doc schemes, including the avoid-unless-asked note",
	},
	{
		id: "runtime/tool-inventory-text",
		section: "runtime",
		condition: allOf(when("hasTools"), not(when("toolListMode"))),
		text: statementRuntimeInventoryText,
		purpose: "the full descriptor text for inline descriptors and providers without native tool schemas",
	},
	{
		id: "runtime/mcp-discovery-notice",
		section: "runtime",
		condition: allOf(when("hasTools"), when("mcpDiscoveryMode")),
		text: statementRuntimeMcpDiscovery,
		purpose: "opens the discovery notice block",
	},
	{
		id: "runtime/mcp-discovery-servers",
		section: "runtime",
		condition: allOf(when("hasTools"), when("mcpDiscoveryMode"), when("hasMCPDiscoveryServers")),
		text: statementRuntimeMcpDiscoveryServers,
		purpose: "names the discoverable servers, which is only worth a line when there are some to name",
	},
	{
		id: "runtime/mcp-discovery-search",
		section: "runtime",
		condition: allOf(when("hasTools"), when("mcpDiscoveryMode")),
		text: statementRuntimeMcpDiscoverySearch,
		purpose:
			"tells the model to search for MCP tools before concluding none exist, which is only true when tools are discovered on demand rather than all being present, and closes the block",
	},
	{
		id: "tool-policy/general",
		section: "tool-policy",
		condition: { kind: "always" },
		text: statementToolPolicyGeneral,
		purpose: "the General heading and the five tool-use rules that hold whatever tools exist",
	},
	{
		id: "tool-policy/parallel-means-subagents",
		section: "tool-policy",
		condition: contains("tools", "task"),
		text: statementToolPolicyParallelMeansSubagents,
		purpose:
			"tells the model that the word `parallel` demands subagents, which is only answerable when the task tool is built",
	},
	{
		id: "tool-policy/tool-io",
		section: "tool-policy",
		condition: { kind: "always" },
		text: statementToolPolicyToolIo,
		purpose: "the Tool I/O heading and the relative-path preference, true of every tool set",
	},
	{
		id: "tool-policy/intent-field",
		section: "tool-policy",
		condition: when("intentTracing"),
		text: statementToolPolicyIntentField,
		purpose: "names the intent parameter most tools take, and names it only when intent tracing puts it on them",
	},
	{
		id: "tool-policy/secrets-redaction",
		section: "tool-policy",
		condition: when("secretsEnabled"),
		text: statementToolPolicySecretsRedaction,
		purpose: "explains `#XXXX#` tokens, shown only to a session whose obfuscator can produce them",
	},
	{
		id: "tool-policy/inspect-image",
		section: "tool-policy",
		condition: allOf(contains("tools", "inspect_image"), contains("tools", "read")),
		text: statementToolPolicyInspectImage,
		purpose: "prefers the image tool over a plain read to spare context, when both tools exist",
	},
	{
		id: "tool-policy/specialized-tools",
		section: "tool-policy",
		condition: { kind: "always" },
		text: statementToolPolicySpecializedTools,
		purpose: "the heading and the MUST that governs the whole specialized-tool list below it",
	},
	{
		id: "tool-policy/specialized-read",
		section: "tool-policy",
		condition: contains("tools", "read"),
		text: statementToolPolicySpecializedRead,
		purpose: "routes file and directory reads to the read tool rather than a shell equivalent",
	},
	{
		id: "tool-policy/specialized-edit",
		section: "tool-policy",
		condition: contains("tools", "edit"),
		text: statementToolPolicySpecializedEdit,
		purpose: "routes surgical edits to the edit tool",
	},
	{
		id: "tool-policy/specialized-write",
		section: "tool-policy",
		condition: contains("tools", "write"),
		text: statementToolPolicySpecializedWrite,
		purpose: "routes create and overwrite to the write tool",
	},
	{
		id: "tool-policy/specialized-lsp",
		section: "tool-policy",
		condition: contains("tools", "lsp"),
		text: statementToolPolicySpecializedLsp,
		purpose: "routes code intelligence to the language server rather than to search",
	},
	{
		id: "tool-policy/specialized-grep",
		section: "tool-policy",
		condition: contains("tools", "grep"),
		text: statementToolPolicySpecializedGrep,
		purpose: "routes regex search to the grep tool and names the shell commands it replaces",
	},
	{
		id: "tool-policy/specialized-glob",
		section: "tool-policy",
		condition: contains("tools", "glob"),
		text: statementToolPolicySpecializedGlob,
		purpose: "routes globbing to the glob tool and names the shell commands it replaces",
	},
	{
		id: "tool-policy/specialized-bash",
		section: "tool-policy",
		condition: contains("tools", "bash"),
		text: statementToolPolicySpecializedBash,
		purpose: "bounds bash to real binaries and short pipelines, and says the shadowing commands are blocked",
	},
	{
		id: "tool-policy/bash-cwd",
		section: "tool-policy",
		condition: contains("tools", "bash"),
		text: statementToolPolicyBashCwd,
		purpose: "keeps commands in the session cwd and makes user cwd corrections binding on the next call",
	},
	{
		id: "tool-policy/specialized-bash-litmus",
		section: "tool-policy",
		condition: contains("tools", "bash"),
		text: statementToolPolicySpecializedBashLitmus,
		purpose:
			"the litmus test for bash versus a tool, its own statement because it is the rule a model actually applies rather than the bound above",
	},
	{
		id: "tool-policy/report-tool-issue",
		section: "tool-policy",
		condition: contains("tools", "report_tool_issue"),
		text: statementToolPolicyReportToolIssue,
		purpose:
			"the critical block asking the model to report inconsistent tool output, which is pointless without the tool that receives it",
	},
	{
		id: "tool-policy/result-contract",
		section: "tool-policy",
		condition: contains("tools", "bash"),
		text: statementToolPolicyResultContract,
		purpose:
			"instructs the model to treat [clean] and [errors] result headers as authoritative and not to search the command result",
	},
	{
		id: "tool-policy/exploration",
		section: "tool-policy",
		condition: { kind: "always" },
		text: statementToolPolicyExploration,
		purpose: "the Exploration heading and the rule against opening files hopefully, true of every tool set",
	},
	{
		id: "tool-policy/exploration-grep",
		section: "tool-policy",
		condition: contains("tools", "grep"),
		text: statementToolPolicyExplorationGrep,
		purpose: "names grep as the way to locate targets during exploration",
	},
	{
		id: "tool-policy/exploration-glob",
		section: "tool-policy",
		condition: contains("tools", "glob"),
		text: statementToolPolicyExplorationGlob,
		purpose: "names glob as the way to map structure during exploration",
	},
	{
		id: "tool-policy/exploration-read",
		section: "tool-policy",
		condition: contains("tools", "read"),
		text: statementToolPolicyExplorationRead,
		purpose: "asks for offset and limit reads rather than whole files, which only means something when read exists",
	},
	{
		id: "tool-policy/lsp",
		section: "tool-policy",
		condition: contains("tools", "lsp"),
		text: statementToolPolicyLsp,
		purpose:
			"the LSP section: the operations a language server answers and the instruction never to hand-search for them",
	},
	{
		id: "tool-policy/ast",
		section: "tool-policy",
		condition: anyOf(contains("tools", "ast_grep"), contains("tools", "ast_edit")),
		text: statementToolPolicyAst,
		purpose: "the AST heading and the prefer-syntax-aware rule, present when either AST tool is built",
	},
	{
		id: "tool-policy/ast-grep",
		section: "tool-policy",
		condition: contains("tools", "ast_grep"),
		text: statementToolPolicyAstGrep,
		purpose:
			"names the structural discovery tool, separate from the edit tool because either can be built without the other",
	},
	{
		id: "tool-policy/ast-edit",
		section: "tool-policy",
		condition: contains("tools", "ast_edit"),
		text: statementToolPolicyAstEdit,
		purpose:
			"names the codemod tool, its own row because a session can have structural search without structural edit",
	},
	{
		id: "tool-policy/ast-plain-text",
		section: "tool-policy",
		condition: anyOf(contains("tools", "ast_grep"), contains("tools", "ast_edit")),
		text: statementToolPolicyAstPlainText,
		purpose:
			"confines plain grep to cases where structure is irrelevant, which only needs saying when a structural tool exists",
	},
	{
		id: "tool-policy/delegation",
		section: "tool-policy",
		condition: allOf(contains("tools", "task"), when("hasSpawnableSubagent")),
		text: statementToolPolicyDelegation,
		purpose: "the Delegation heading, which opens the section the task tool makes real",
	},
	{
		id: "tool-policy/delegation-codex-eager",
		section: "tool-policy",
		condition: allOf(
			contains("tools", "task"),
			when("hasSpawnableSubagent"),
			when("useCodexTaskPrompt"),
			when("eagerTasks"),
		),
		text: statementToolPolicyDelegationCodexEager,
		purpose:
			"the Codex-style wording that activates proactive delegation and revokes any earlier ask-first instruction",
	},
	{
		id: "tool-policy/delegation-codex-off",
		section: "tool-policy",
		condition: allOf(
			contains("tools", "task"),
			when("hasSpawnableSubagent"),
			when("useCodexTaskPrompt"),
			not(when("eagerTasks")),
		),
		text: statementToolPolicyDelegationCodexOff,
		purpose:
			"the Codex-style wording that forbids spawning without an explicit request; the else arm of the same block, hence `not`",
	},
	{
		id: "tool-policy/delegation-required",
		section: "tool-policy",
		condition: allOf(
			contains("tools", "task"),
			when("hasSpawnableSubagent"),
			not(when("useCodexTaskPrompt")),
			when("eagerTasks"),
			when("eagerTasksAlways"),
		),
		text: statementToolPolicyDelegationRequired,
		purpose:
			"the strongest delegation setting, requiring substantial work to use the closest enabled agent role while unmatched work remains inline",
	},
	{
		id: "tool-policy/delegation-preferred",
		section: "tool-policy",
		condition: allOf(
			contains("tools", "task"),
			when("hasSpawnableSubagent"),
			not(when("useCodexTaskPrompt")),
			when("eagerTasks"),
			not(when("eagerTasksAlways")),
		),
		text: statementToolPolicyDelegationPreferred,
		purpose:
			"the softer delegation setting, encouraging substantial work to use the closest enabled agent role while unmatched work remains inline",
	},
	{
		id: "tool-policy/delegation-allowed",
		section: "tool-policy",
		condition: allOf(
			contains("tools", "task"),
			when("hasSpawnableSubagent"),
			not(when("useCodexTaskPrompt")),
			not(when("eagerTasks")),
		),
		text: statementToolPolicyDelegationAllowed,
		purpose:
			"the weakest delegation setting: the ability stays, an explicit request is the trigger, and the model does not fan out on its own initiative",
	},
	{
		id: "tool-policy/delegation-subagent-value",
		section: "tool-policy",
		condition: allOf(contains("tools", "task"), when("hasSpawnableSubagent"), not(when("useCodexTaskPrompt"))),
		text: statementToolPolicyDelegationSubagentValue,
		purpose:
			"the first bullet on what a subagent is FOR: a separate context rather than a lesser model. The brace nesting hides this group inside the not-Codex branch rather than the task block",
	},
	{
		id: "tool-policy/delegation-no-shrinking",
		section: "tool-policy",
		condition: allOf(contains("tools", "task"), when("hasSpawnableSubagent"), not(when("useCodexTaskPrompt"))),
		text: statementToolPolicyDelegationNoShrinking,
		purpose: "keeps scope intact while limiting delegation to assignments an enabled role can actually own",
	},
	{
		id: "tool-policy/delegation-gates",
		section: "tool-policy",
		condition: allOf(contains("tools", "task"), when("hasSpawnableSubagent")),
		text: statementToolPolicyDelegationGates,
		purpose:
			"the Delegation gates list: scope and plan ownership, real independence, prerequisites, necessary sequencing, and who owns the user's intent",
	},
	{
		id: "tool-policy/delegation-concurrency-cap",
		section: "tool-policy",
		condition: allOf(contains("tools", "task"), when("hasSpawnableSubagent"), when("MAX_CONCURRENCY")),
		text: statementToolPolicyDelegationConcurrencyCap,
		purpose:
			"quotes the concurrency cap, gated on there being one; the template compares MAX_CONCURRENCY against zero with the `when` helper, and Handlebars truthiness already makes 0 falsy, so a plain `when` condition is exactly equivalent and no comparison form is needed",
	},
	{
		id: "execution-workflow/scope",
		section: "execution-workflow",
		condition: { kind: "always" },
		text: statementExecutionScope,
		purpose: "the Scope heading and the step-1 framing every request goes through",
	},
	{
		id: "execution-workflow/read-skills-and-rules",
		section: "execution-workflow",
		condition: allOf(when("skills"), when("rules")),
		text: statementExecutionReadSkillsAndRules,
		purpose:
			"tells the model to read skills and rules first, for the case where both exist. THREE ROWS, NOT ONE SENTENCE WITH ARMS: this line used to pick between skills, rules and both with nested Handlebars, and the row said that stayed inline because it varies within the sentence. It varies within a sentence short enough to write out three times, and writing it out is what lets the condition live in one place. Exactly one of these three holds whenever either input exists, so the coverage is the same and no render can produce two of them",
	},
	{
		id: "execution-workflow/read-skills-only",
		section: "execution-workflow",
		condition: allOf(when("skills"), not(when("rules"))),
		text: statementExecutionReadSkillsOnly,
		purpose: "the same line when skills exist and rules do not",
	},
	{
		id: "execution-workflow/read-rules-only",
		section: "execution-workflow",
		condition: allOf(not(when("skills")), when("rules")),
		text: statementExecutionReadRulesOnly,
		purpose: "the same line when rules exist and skills do not",
	},
	{
		id: "execution-workflow/scope-plan-first",
		section: "execution-workflow",
		condition: { kind: "always" },
		text: statementExecutionScopePlanFirst,
		purpose: "requires planning and convention research before touching files on multi-file work",
	},
	{
		id: "execution-workflow/research",
		section: "execution-workflow",
		condition: { kind: "always" },
		text: statementExecutionResearch,
		purpose: "the Research heading and the read-sections-not-snippets rule with its ban on a second convention",
	},
	{
		id: "execution-workflow/research-lsp-references",
		section: "execution-workflow",
		condition: contains("tools", "lsp"),
		text: statementExecutionResearchLspReferences,
		purpose:
			"requires a references lookup before changing an exported symbol, which only a language server can answer",
	},
	{
		id: "execution-workflow/research-reread",
		section: "execution-workflow",
		condition: { kind: "always" },
		text: statementExecutionResearchReread,
		purpose: "requires re-reading after a tool failure or an external change",
	},
	{
		id: "execution-workflow/decompose",
		section: "execution-workflow",
		condition: { kind: "always" },
		text: statementExecutionDecompose,
		purpose: "the Decompose heading, todo discipline, and the rule that cleanup is not planned up front",
	},
	{
		id: "execution-workflow/decompose-todo-batching",
		section: "execution-workflow",
		condition: contains("tools", "todo"),
		text: statementExecutionDecomposeTodoBatching,
		purpose:
			"keeps a todo op in the same message as the turn's real work, because a turn whose only tool call is todo spends a full model round trip on bookkeeping",
	},
	{
		id: "execution-workflow/implement",
		section: "execution-workflow",
		condition: { kind: "always" },
		text: statementExecutionImplement,
		purpose: "the Implement heading and the fix-at-source, prefer-existing-files, review-as-the-user rules",
	},
	{
		id: "execution-workflow/implement-grep",
		section: "execution-workflow",
		condition: contains("tools", "grep"),
		text: statementExecutionImplementGrep,
		purpose: "grep instead of guessing, which needs the tool that makes it possible",
	},
	{
		id: "execution-workflow/implement-ask-first",
		section: "execution-workflow",
		condition: contains("tools", "ask"),
		text: statementExecutionImplementAskFirst,
		purpose: "asks before destructive commands when there is a tool to ask with",
	},
	{
		id: "execution-workflow/implement-no-destructive",
		section: "execution-workflow",
		condition: not(contains("tools", "ask")),
		text: statementExecutionImplementNoDestructive,
		purpose:
			"forbids destructive commands outright when there is no way to ask; the else arm of the same block, so it is `not` rather than a second variable",
	},
	{
		id: "execution-workflow/verify",
		section: "execution-workflow",
		condition: { kind: "always" },
		text: statementExecutionVerify,
		purpose: "the Verify heading, the proof-per-ask-type table, the smoke-test rule and the test-quality bar",
	},
	{
		id: "execution-workflow/verify-browser",
		section: "execution-workflow",
		condition: contains("tools", "browser"),
		text: statementExecutionVerifyBrowser,
		purpose:
			"names the browser tool as the way to drive a web UI, so the generic verify bullet above can stay tool-agnostic for the sessions that ship without it",
	},
	{
		id: "execution-workflow/cleanup",
		section: "execution-workflow",
		condition: { kind: "always" },
		text: statementExecutionCleanup,
		purpose: "the Cleanup phase: what it covers, that it is last, and that it is never pre-planned",
	},
	{
		id: "delivery-contract/contract",
		section: "delivery-contract",
		condition: { kind: "always" },
		text: statementDeliveryContract,
		purpose: "the inviolable contract block: never substitute an easier problem and require a clean cutover",
	},
	{
		id: "delivery-contract/no-partial-yield",
		section: "delivery-contract",
		condition: { kind: "always" },
		text: statementDeliveryNoPartialYield,
		purpose:
			"forbids yielding on a phase boundary, a todo flip, or a sub-step, which is the stop condition that ends a run with the work unfinished",
	},
	{
		id: "delivery-contract/no-punting",
		section: "delivery-contract",
		condition: { kind: "always" },
		text: statementDeliveryNoPunting,
		purpose:
			"forbids handing partially solved work back to the user, the other shape of an early stop and the one that reads as a report rather than as quitting",
	},
	{
		id: "delivery-contract/completeness",
		section: "delivery-contract",
		condition: { kind: "always" },
		text: statementDeliveryCompleteness,
		purpose:
			"the completeness block defining what done means and banning stubs, silent scope reduction and relabelled unfinished work",
	},
	{
		id: "delivery-contract/evidence-and-output",
		section: "delivery-contract",
		condition: { kind: "always" },
		text: statementDeliveryEvidenceAndOutput,
		purpose:
			"the evidence block: output matches the ask, claims are grounded, inferences are marked, verification claims match what ran",
	},
	{
		id: "delivery-contract/yielding",
		section: "delivery-contract",
		condition: { kind: "always" },
		text: statementDeliveryYielding,
		purpose:
			"the yielding checklist and the bar for declaring blocked, which is the last thing the model reads before answering",
	},
	{
		id: "delivery-contract/personality",
		section: "delivery-contract",
		condition: when("personality"),
		text: statementDeliveryPersonality,
		purpose:
			"the operator's personality text, wrapped in its own tags, absent entirely when no personality is configured",
	},
	{
		id: "delivery-contract/critical",
		section: "delivery-contract",
		condition: { kind: "always" },
		text: statementDeliveryCritical,
		purpose: "the closing critical block: never narrate budgets, never re-audit an applied edit",
	},
	{
		id: "delivery-contract/verification-source",
		section: "delivery-contract",
		condition: { kind: "always" },
		text: statementDeliveryVerificationSource,
		purpose:
			"names the tool result as the verification, so the row above it forbidding a re-audit reads as a redirection rather than as a ban on checking anything",
	},
	{
		id: "delivery-contract/never-stop-early",
		section: "delivery-contract",
		condition: { kind: "always" },
		text: statementDeliveryNeverStopEarly,
		purpose:
			"repeats the no-early-stop prohibition in the last position the model reads before the conversation, which is the placement upstream uses and the reason it is stated twice",
	},
] as const satisfies readonly PromptStatement[];

export type PromptStatementEntry = (typeof PROMPT_STATEMENTS)[number];

export type PromptStatementId = PromptStatementEntry["id"];

export const PROMPT_STATEMENT_IDS: readonly PromptStatementId[] = PROMPT_STATEMENTS.map(statement => statement.id);

export const STATEMENT_SECTIONS: readonly string[] = TEMPLATE_SECTION_IDS;

{
	const covered = new Set<string>(PROMPT_STATEMENTS.map(statement => statement.section));
	const uncovered = STATEMENT_SECTIONS.filter(section => !covered.has(section));
	if (uncovered.length > 0) {
		throw new Error(
			`system prompt sections have no statements: ${uncovered.join(", ")}. ` +
				"Add a statement row and its .md file under statements/<section>/; " +
				"the zero-prose outer template has no fallback content.",
		);
	}
	const stray = Array.from(covered).filter(section => !STATEMENT_SECTIONS.includes(section));
	if (stray.length > 0) {
		throw new Error(
			`statements name sections the document does not have: ${stray.join(", ")}. ` +
				`Valid sections: ${STATEMENT_SECTIONS.join(", ")}. Their text would be assembled and never ` +
				"emitted, so the statement would read as shipped while no model ever sees it.",
		);
	}
}

const EMPTY_STATEMENTS: readonly PromptStatementEntry[] = Object.freeze([]);
const STATEMENTS_BY_SECTION = new Map<string, readonly PromptStatementEntry[]>(
	STATEMENT_SECTIONS.map(
		section =>
			[section, Object.freeze(PROMPT_STATEMENTS.filter(statement => statement.section === section))] as const,
	),
);
const STATEMENTS_BY_ID = new Map<string, PromptStatementEntry>(
	PROMPT_STATEMENTS.map(statement => [statement.id, statement]),
);
const SECTION_BANNERS = new Map(
	SYSTEM_PROMPT_SECTIONS.map(section => [section.id, section.name ? `${renderBanner(section.name)}\n` : ""] as const),
);

export function statementsOf(section: string): readonly PromptStatementEntry[] {
	return STATEMENTS_BY_SECTION.get(section) ?? EMPTY_STATEMENTS;
}

export function statementById(id: string): PromptStatementEntry | undefined {
	return STATEMENTS_BY_ID.get(id);
}

export function conditionVariables(condition: StatementCondition): readonly string[] {
	switch (condition.kind) {
		case "always":
			return [];
		case "when":
			return [condition.variable];
		case "whenContains":
			return [condition.collection];
		case "whenAll":
		case "whenAny":
			return condition.conditions.flatMap(conditionVariables);
		case "not":
			return conditionVariables(condition.condition);
	}
}

export type StatementContext = Readonly<Record<string, unknown>>;

export function conditionHolds(condition: StatementCondition, context: StatementContext): boolean {
	switch (condition.kind) {
		case "always":
			return true;
		case "when":
			return isTruthy(context[condition.variable]);
		case "whenContains": {
			const collection = context[condition.collection];
			if (Array.isArray(collection)) return collection.includes(condition.member);
			if (collection instanceof Map) return collection.has(condition.member);
			if (collection instanceof Set) return collection.has(condition.member);
			return false;
		}
		case "whenAll":
			return condition.conditions.every(nested => conditionHolds(nested, context));
		case "whenAny":
			return condition.conditions.some(nested => conditionHolds(nested, context));
		case "not":
			return !conditionHolds(condition.condition, context);
	}
}

function isTruthy(value: unknown): boolean {
	if (Array.isArray(value)) return value.length > 0;
	return Boolean(value);
}

export function assembleSection(
	section: string,
	context: StatementContext,
	overrides: StatementOverrides = {},
): string {
	let out = sectionBanner(section);
	for (const statement of statementsOf(section)) {
		if (!conditionHolds(statement.condition, context)) continue;
		if (!Object.hasOwn(overrides, statement.id)) {
			out += statement.text;
			continue;
		}
		const replacement = overrides[statement.id];
		if (replacement !== null) out += replacement;
	}
	return out;
}

export type StatementOverrides = Readonly<Record<string, string | null>>;

export function parseStatementOverridesJson(raw: string | undefined): StatementOverrides {
	if (raw === undefined || raw.trim() === "") return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS is set but is not valid JSON: ${err}`);
	}
	if (!isRecord(parsed)) {
		throw new Error(
			"VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS must be a JSON object of statement id -> replacement text " +
				`(or null to ablate), got ${Array.isArray(parsed) ? "an array" : parsed === null ? "null" : typeof parsed}`,
		);
	}
	return resolveStatementOverrides(parsed);
}

export function resolveStatementOverrides(raw: Readonly<Record<string, unknown>> | undefined): StatementOverrides {
	if (!raw) return {};
	const out: Record<string, string | null> = {};
	for (const [id, value] of Object.entries(raw)) {
		if (statementById(id) === undefined) {
			const section = id.includes("/") ? id.slice(0, id.indexOf("/")) : "";
			const nearby = statementsOf(section).map(statement => statement.id);
			throw new Error(
				`statement override names unknown statement "${id}"` +
					(nearby.length > 0 ? `; statements in ${section}: ${nearby.join(", ")}` : "") +
					(nearby.length === 0 ? `; valid sections: ${STATEMENT_SECTIONS.join(", ")}` : ""),
			);
		}
		if (value !== null && typeof value !== "string") {
			throw new Error(
				`statement override for "${id}" must be a string or null (to ablate the statement), got ${typeof value}`,
			);
		}
		if (typeof value === "string") {
			assertNoRegisteredBanners(value, SYSTEM_SECTION_BANNERS, `statement override for "${id}"`);
		}
		out[id] = value;
	}
	return out;
}

export function sectionBanner(section: string): string {
	return SECTION_BANNERS.get(section) ?? "";
}

export function describeCondition(condition: StatementCondition): string {
	switch (condition.kind) {
		case "always":
			return "always";
		case "when":
			return condition.variable;
		case "whenContains":
			return `${condition.collection} has ${condition.member}`;
		case "whenAll":
			return condition.conditions.length === 0
				? "always"
				: condition.conditions.map(describeCondition).join(" and ");
		case "whenAny":
			return condition.conditions.length === 0 ? "never" : condition.conditions.map(describeCondition).join(" or ");
		case "not": {
			const inner = describeCondition(condition.condition);
			return inner.includes(" and ") || inner.includes(" or ") ? `not (${inner})` : `not ${inner}`;
		}
		default: {
			const unreachable: never = condition;
			throw new Error(`unhandled condition: ${JSON.stringify(unreachable)}`);
		}
	}
}
