import { declareSettings, type SettingPath, type SettingValue } from "@veyyon/kernel/settings/schema";
import type { SettingTab } from "@veyyon/settings";
import { AGENTS_SETTINGS } from "./settings-domains/agents";
import { APPEARANCE_SETTINGS } from "./settings-domains/appearance";
import { CONTEXT_SETTINGS } from "./settings-domains/context";
import { EDITING_SETTINGS } from "./settings-domains/editing";
import { GENERAL_SETTINGS } from "./settings-domains/general";
import { GLOBAL_SETTINGS } from "./settings-domains/global";
import { INTERACTION_SETTINGS } from "./settings-domains/interaction";
import { MODEL_SETTINGS } from "./settings-domains/model";
import { PROVIDERS_SETTINGS } from "./settings-domains/providers";
import { RESOURCES_SETTINGS } from "./settings-domains/resources";
import { TASKS_SETTINGS } from "./settings-domains/tasks";
import { TOOLS_SETTINGS } from "./settings-domains/tools";

/**
 * The query surface, re-exported from the registry that answers it.
 *
 * A query reads the tables this module registers, so a caller that imports the query from the
 * kernel directly asks a registry that may still be empty: the exa provider read `getDefault` at
 * module scope and threw before this module had loaded. Importing the query from here loads the
 * tables first, by the one import edge the caller already has.
 */
export {
	describeSettingTypeMismatch,
	getDefault,
	getEnumValues,
	getPathsForTab,
	getType,
	getUi,
	hasUi,
	isSettingPath,
	isUnsetNumberPath,
	retiredBy,
	type SettingPath,
	type SettingValue,
} from "@veyyon/kernel/settings/schema";
export { type BashInterceptorRule, DEFAULT_BASH_INTERCEPTOR_RULES } from "./bash-interceptor-rules";

/** Unified settings schema - single source of truth for all settings.
 *
 * Each setting is defined once here with:
 * - Type and default value
 * - Optional UI metadata (label, description, tab, group)
 *
 * UI metadata places the setting in the settings panel: `tab` picks the
 * panel tab, `group` the titled section within it (registered in
 * TAB_GROUPS). Sections render in TAB_GROUPS order; settings within a
 * section keep declaration order.
 *
 * The Settings singleton provides type-safe path-based access:
 *   settings.get("compaction.enabled")  // => boolean
 *   settings.set("theme.dark", "titanium")  // sync, saves in background
 */

// ═══════════════════════════════════════════════════════════════════════════
// Schema Definition Types
// ═══════════════════════════════════════════════════════════════════════════

/** Tab display metadata - icon is resolved via theme.symbol() */
export type TabMetadata = { label: string; icon: `tab.${string}` };

/**
 * Ordered list of tabs for UI rendering. The everyday per-profile tabs come
 * first (Appearance is the landing category); "global" is the machine-wide,
 * cross-profile scope and sits last, the conventional place for an advanced /
 * scope tab, so opening `/settings` still lands on the common per-profile view.
 */
export const SETTING_TABS: SettingTab[] = [
	"appearance",
	"model",
	"interaction",
	"resources",
	"context",
	"rules",
	"memory",
	"files",
	"shell",
	"tools",
	"tasks",
	"agents",
	"providers",
	"experimental",
	"global",
];

/** Tab display metadata - icon is a symbol key from theme.ts (tab.*) */
export const TAB_METADATA: Record<SettingTab, { label: string; icon: `tab.${string}` }> = {
	global: { label: "Global", icon: "tab.global" },
	appearance: { label: "Appearance", icon: "tab.appearance" },
	model: { label: "Model", icon: "tab.model" },
	interaction: { label: "Interaction", icon: "tab.interaction" },
	resources: { label: "Resources", icon: "tab.resources" },
	context: { label: "Context", icon: "tab.context" },
	rules: { label: "Rules", icon: "tab.rules" },
	memory: { label: "Memory", icon: "tab.memory" },
	files: { label: "Files", icon: "tab.files" },
	shell: { label: "Shell", icon: "tab.shell" },
	tools: { label: "Tools", icon: "tab.tools" },
	tasks: { label: "Tasks", icon: "tab.tasks" },
	agents: { label: "Agents", icon: "tab.agents" },
	providers: { label: "Providers", icon: "tab.providers" },
	experimental: { label: "Experimental", icon: "tab.experimental" },
};

/**
 * Ordered section groups per tab. Settings declare their section via `ui.group`;
 * the settings UI renders groups in this order with a heading row between them.
 * Ungrouped settings render first, before any section heading.
 */
export const TAB_GROUPS: Record<SettingTab, readonly string[]> = {
	global: ["Machine Limits", "Profiles", "Credentials", "Auth Broker"],
	appearance: ["Theme", "Status Line", "Display"],
	model: [
		"Models",
		"Compaction",
		"Roles",
		"Thinking",
		"Sampling",
		"Prompt",
		"Retry & Fallback",
		"Advisor",
		"Prewalk",
		"Vision",
	],
	interaction: [
		"Input",
		"Session",
		"Approvals",
		"Notifications",
		"Speech",
		"Collab",
		"Magic Keywords",
		"Startup & Updates",
		"Profile",
		"Power (macOS)",
		"Agent",
		"Git",
	],
	resources: ["CPU", "Memory", "Disk", "Processes"],
	context: ["General", "Prompt Cache", "Session Instrumentation"],
	rules: ["Rules", "Stream Interrupts (TTSR)"],
	memory: ["General", "Mnemopi", "Hindsight"],
	files: ["Editing", "Reading", "Read Summaries", "LSP"],
	shell: ["Bash", "Eval & Runtimes"],
	tools: [
		"Available Tools",
		"Todos",
		"Launch",
		"Search Context",
		"Browser",
		"GitHub",
		"Output Limits",
		"Execution",
		"Discovery & MCP",
		"Developer",
	],
	tasks: ["Modes", "Commands & Skills"],
	agents: ["Delegation", "Agents", "Limits", "Idle Agents", "Isolation", "Coordination"],
	providers: ["Accounts", "Services", "Discovery", "Fireworks", "Tiny Model", "Protocol", "Timeouts", "Privacy"],
	experimental: ["Argot", "Tool Calling", "Auto-Learn"],
};

/** Status line segment identifiers */
export type StatusLineSegmentId =
	| "pi"
	| "model"
	| "account"
	| "mode"
	| "path"
	| "git"
	| "pr"
	| "agents"
	| "background"
	| "token_in"
	| "token_out"
	| "token_total"
	| "token_rate"
	| "cost"
	| "context_pct"
	| "context_total"
	| "time_spent"
	| "time"
	| "session"
	| "hostname"
	| "profile"
	| "cache_read"
	| "cache_write"
	| "cache_hit"
	| "session_name"
	| "usage"
	| "collab";

// ═══════════════════════════════════════════════════════════════════════════
// Schema Definition
// ═══════════════════════════════════════════════════════════════════════════

export interface ModelTagDef {
	name: string;
	color?: string;
	/** If true, the role is functional but not shown in the model selector UI. */
	hidden?: boolean;
}

export interface ModelTagsSettings {
	[key: string]: ModelTagDef;
}

/**
 * Every domain slice, keyed by its file, in the order they are composed below.
 *
 * The spread that builds {@link SETTINGS_SCHEMA} has to stay a literal for the
 * `SettingPath` inference to work, so this list exists alongside it rather than
 * driving it. Nothing reads it at runtime: it is here so the composition guard in
 * `test/config/settings-domain-composition.test.ts` compares the schema against a
 * list that lives NEXT TO the spread instead of a copy maintained in the test,
 * where a new domain was simply forgotten and the guard silently stopped covering
 * it. Add a slice below and here in the same edit; the guard fails if you do not.
 */
export const SETTINGS_DOMAIN_SLICES: Record<string, Record<string, unknown>> = {
	global: GLOBAL_SETTINGS,
	general: GENERAL_SETTINGS,
	appearance: APPEARANCE_SETTINGS,
	model: MODEL_SETTINGS,
	interaction: INTERACTION_SETTINGS,
	context: CONTEXT_SETTINGS,
	editing: EDITING_SETTINGS,
	resources: RESOURCES_SETTINGS,
	tools: TOOLS_SETTINGS,
	tasks: TASKS_SETTINGS,
	agents: AGENTS_SETTINGS,
	providers: PROVIDERS_SETTINGS,
};

export const SETTINGS_SCHEMA = declareSettings({
	...GLOBAL_SETTINGS,
	...GENERAL_SETTINGS,
	...APPEARANCE_SETTINGS,
	...MODEL_SETTINGS,
	...INTERACTION_SETTINGS,
	...CONTEXT_SETTINGS,
	...EDITING_SETTINGS,
	...RESOURCES_SETTINGS,
	...TOOLS_SETTINGS,
	...TASKS_SETTINGS,
	...AGENTS_SETTINGS,
	...PROVIDERS_SETTINGS,
} as const);

// ═══════════════════════════════════════════════════════════════════════════
// Type Inference
// ═══════════════════════════════════════════════════════════════════════════

type Schema = typeof SETTINGS_SCHEMA;

declare module "@veyyon/kernel/settings/schema" {
	interface DeclaredSettings extends Schema {}
}

// ═══════════════════════════════════════════════════════════════════════════
// Derived Types from Schema
// ═══════════════════════════════════════════════════════════════════════════

/** Status line preset - derived from schema */
export type StatusLinePreset = SettingValue<"statusLine.preset">;

/** Status line separator style - derived from schema */
export type StatusLineSeparatorStyle = SettingValue<"statusLine.separator">;

/** Tree selector filter mode - derived from schema */
export type TreeFilterMode = SettingValue<"treeFilterMode">;

/** Personality preset - derived from schema */
export type Personality = SettingValue<"personality">;

/** Codex auto-redeem mode - derived from schema */
export type CodexAutoRedeemMode = SettingValue<"codexResets.autoRedeem">;

/** Value types under a schema prefix; group interfaces retain their public optional-key contracts. */
export type GroupSettings<Prefix extends string> = {
	[P in SettingPath as P extends `${Prefix}.${infer Key}` ? Key : never]: SettingValue<P>;
};

// ═══════════════════════════════════════════════════════════════════════════
// Typed Group Definitions
// ═══════════════════════════════════════════════════════════════════════════

export interface CompactionSettings
	extends Omit<
		GroupSettings<"compaction">,
		"threshold" | "model" | "remote" | "modelFallbackStrategy" | "modelContextWindow"
	> {
	/** The one compaction-trigger value, unit included: `auto`, `85%`, or `170000`. */
	threshold: string;
	model?: string;
}

export interface RecapSettings extends GroupSettings<"recap"> {}

export interface TitleSettings extends GroupSettings<"title"> {}

export interface ContextPromotionSettings extends GroupSettings<"contextPromotion"> {}

export interface RetrySettings
	extends Pick<GroupSettings<"retry">, "enabled" | "maxRetries" | "baseDelayMs" | "maxDelayMs" | "modelFallback"> {}

export interface MemoriesSettings extends Omit<GroupSettings<"memories">, "phase1InputTokenLimit"> {}

export interface TodoCompletionSettings {
	enabled: boolean;
	maxReminders: number;
}

export interface BranchSummarySettings extends GroupSettings<"branchSummary"> {}

export interface SkillsSettings extends Partial<GroupSettings<"skills">> {
	/**
	 * Skills load only from the active profile's Veyyon agent dir
	 * (`~/.veyyon/profiles/<name>/agent/skills`), its managed auto-learn skills,
	 * and skills bundled with plugins installed into that profile. There is no
	 * cross-computer autodiscovery and no per-source toggle: Claude, Codex, the
	 * Agent Skills standard, GitHub, and OpenCode directories are never scanned.
	 * The includeSkills and ignoredSkills lists filter that profile set by name.
	 */
	disabledExtensions?: string[];
}

export interface CommitSettings extends GroupSettings<"commit"> {}

export interface TtsrSettings
	extends Pick<GroupSettings<"ttsr">, "enabled" | "contextMode" | "interruptMode" | "repeatMode" | "repeatGap">,
		Partial<Pick<GroupSettings<"ttsr">, "builtinRules" | "disabledRules" | "experimentalRules">> {}

export interface ExaSettings extends GroupSettings<"exa"> {}

/**
 * Every `statusLine.*` setting, derived from the schema rather than restated.
 */
export type StatusLineSettings = GroupSettings<"statusLine">;

export interface ThinkingBudgetsSettings extends GroupSettings<"thinkingBudgets"> {}

export interface SttSettings extends Pick<GroupSettings<"stt">, "enabled" | "language"> {
	modelName: string;
	streaming: boolean;
}

export interface ShellMinimizerSettings extends GroupSettings<"shellMinimizer"> {}

export interface CodexResetsSettings extends GroupSettings<"codexResets"> {}

export interface GcSettings extends GroupSettings<"gc"> {}

/** Map group prefix -> typed settings interface */
export interface GroupTypeMap {
	compaction: CompactionSettings;
	recap: RecapSettings;
	title: TitleSettings;
	contextPromotion: ContextPromotionSettings;
	retry: RetrySettings;
	memories: MemoriesSettings;
	branchSummary: BranchSummarySettings;
	skills: SkillsSettings;
	commit: CommitSettings;
	ttsr: TtsrSettings;
	exa: ExaSettings;
	statusLine: StatusLineSettings;
	thinkingBudgets: ThinkingBudgetsSettings;
	stt: SttSettings;
	modelRoles: Record<string, string>;
	modelTags: ModelTagsSettings;
	cycleOrder: string[];
	shellMinimizer: ShellMinimizerSettings;
	codexResets: CodexResetsSettings;
	gc: GcSettings;
}

export type GroupPrefix = keyof GroupTypeMap;
