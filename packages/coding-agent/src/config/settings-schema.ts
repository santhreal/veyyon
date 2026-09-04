import { declareSettings, type SettingPath, type SettingValue } from "@veyyon/kernel/settings/schema";
import type { SettingTab } from "@veyyon/settings";
import { APPEARANCE_SETTINGS } from "./settings-domains/appearance";
import { CONTEXT_SETTINGS } from "./settings-domains/context";
import { EDITING_SETTINGS } from "./settings-domains/editing";
import { GENERAL_SETTINGS } from "./settings-domains/general";
import { GLOBAL_SETTINGS } from "./settings-domains/global";
import { INTERACTION_SETTINGS } from "./settings-domains/interaction";
import { MODEL_SETTINGS } from "./settings-domains/model";
import { PROVIDERS_SETTINGS } from "./settings-domains/providers";
import { RESOURCES_SETTINGS } from "./settings-domains/resources";
import { SUBAGENTS_SETTINGS } from "./settings-domains/subagents";
import { TASKS_SETTINGS } from "./settings-domains/tasks";
import { TOOLS_SETTINGS } from "./settings-domains/tools";

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
	"subagents",
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
	subagents: { label: "Subagents", icon: "tab.subagents" },
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
	subagents: ["Delegation", "Subagents", "Limits", "Park", "Prune", "Isolation", "Coordination"],
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
	| "subagents"
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
	subagents: SUBAGENTS_SETTINGS,
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
	...SUBAGENTS_SETTINGS,
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

// ═══════════════════════════════════════════════════════════════════════════
// Typed Group Definitions
// ═══════════════════════════════════════════════════════════════════════════

export interface CompactionSettings {
	enabled: boolean;
	strategy: "summary";
	/** The one compaction-trigger value, unit included: `auto`, `85%`, or `170000`. */
	threshold: string;
	/** Retired; read only by `withLegacyCompactionThreshold`. */
	thresholdPercent: number;
	/** Retired; read only by `withLegacyCompactionThreshold`. */
	thresholdTokens: number;
	model?: string;
	reserveTokens: number | undefined;
	keepRecentTokens: number;
	midTurnEnabled: boolean;
	handoffSaveToDisk: boolean;
	autoContinue: boolean;
	/** Optional summarizer endpoint for the `summary` strategy — returns summary text. */
	remoteEndpoint: string | undefined;
	idleEnabled: boolean;
	idleThresholdTokens: number;
	idleTimeoutSeconds: number;
	supersedeReads: boolean;
	dropUseless: boolean;
}

export interface RecapSettings {
	enabled: boolean;
	idleSeconds: number;
}

export interface TitleSettings {
	refreshOnReplan: boolean;
}

export interface ContextPromotionSettings {
	enabled: boolean;
}
export interface RetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
	modelFallback: boolean;
}

export interface MemoriesSettings {
	enabled: boolean;
	maxRolloutsPerStartup: number;
	maxRolloutAgeDays: number;
	minRolloutIdleHours: number;
	threadScanLimit: number;
	maxRawMemoriesForGlobal: number;
	stage1Concurrency: number;
	stage1LeaseSeconds: number;
	stage1RetryDelaySeconds: number;
	phase2LeaseSeconds: number;
	phase2RetryDelaySeconds: number;
	phase2HeartbeatSeconds: number;
	rolloutPayloadPercent: number;
	fallbackTokenLimit: number;
	summaryInjectionTokenLimit: number;
}

export interface TodoCompletionSettings {
	enabled: boolean;
	maxReminders: number;
}

export interface BranchSummarySettings {
	enabled: boolean;
	reserveTokens: number;
}

export interface SkillsSettings {
	/** Master switch. When false, no skills load at all. */
	enabled?: boolean;
	/** Expose loaded skills as `/skill:<name>` slash commands. */
	enableSkillCommands?: boolean;
	/**
	 * Skills load only from the active profile's Veyyon agent dir
	 * (`~/.veyyon/profiles/<name>/agent/skills`), its managed auto-learn skills,
	 * and skills bundled with plugins installed into that profile. There is no
	 * cross-computer autodiscovery and no per-source toggle: Claude, Codex, the
	 * Agent Skills standard, GitHub, and OpenCode directories are never scanned.
	 * The two lists below filter that profile set by skill name.
	 */
	ignoredSkills?: string[];
	includeSkills?: string[];
	disabledExtensions?: string[];
}

export interface CommitSettings {
	mapReduceEnabled: boolean;
	mapReduceMinFiles: number;
	mapReduceMaxFileTokens: number;
	mapReduceTimeoutMs: number;
	mapReduceMaxConcurrency: number;
	changelogMaxDiffChars: number;
}

export interface TtsrSettings {
	enabled: boolean;
	contextMode: "discard" | "keep";
	interruptMode: "never" | "prose-only" | "tool-only" | "always";
	repeatMode: "once" | "after-gap";
	repeatGap: number;
	/** Bucketing-only (read by bucketRules, not the TtsrManager). */
	builtinRules?: boolean;
	/** Bucketing-only (read by bucketRules, not the TtsrManager). */
	disabledRules?: string[];
	/** Bucketing-only: experimental rule names the operator opted into. */
	experimentalRules?: string[];
}

export interface ExaSettings {
	enabled: boolean;
	enableSearch: boolean;
	searchDelayMs: number;
	enableResearcher: boolean;
	enableWebsets: boolean;
}

/**
 * Every `statusLine.*` setting, derived from the schema rather than restated.
 *
 * `getGroup("statusLine")` returns every key with that prefix at run time, and the
 * hand-written version of this interface listed six of eleven: `enabled`,
 * `sessionAccent`, `transparent`, `compactThinkingLevel` and `showAccount` were all
 * readable and none of them type-checked. A mapped type cannot fall behind the next
 * footline knob someone adds.
 */
export type StatusLineSettings = {
	[P in SettingPath as P extends `statusLine.${infer Key}` ? Key : never]: SettingValue<P>;
};

export interface ThinkingBudgetsSettings {
	minimal: number;
	low: number;
	medium: number;
	high: number;
	xhigh: number;
	max: number;
}

export interface SttSettings {
	enabled: boolean;
	language: string | undefined;
	modelName: string;
	streaming: boolean;
}

export interface ShellMinimizerSettings {
	enabled: boolean;
	settingsPath: string | undefined;
	only: string[];
	except: string[];
	maxCaptureBytes: number;
	sourceOutlineLevel: "default" | "aggressive";
	legacyFilters: boolean | undefined;
}
export type CodexAutoRedeemMode = "unset" | "yes" | "no";

export interface CodexResetsSettings {
	autoRedeem: CodexAutoRedeemMode;
	minBlockedMinutes: number;
	keepCredits: number;
}

export interface GcSettings {
	blobs: boolean;
	archive: boolean;
	wal: boolean;
	coldArchiveAfterDays: number;
	retainNewestGlobal: number;
	retainNewestPerCwd: number;
	/** Minutes a file must have gone unwritten before GC may delete or archive it. Floored at 1. */
	writeGraceMinutes: number;
}

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
