// Owners, not the `@veyyon/utils` barrel: 1 module against 74.
import { isRecord } from "@veyyon/utils/type-guards";
import { UNSET_NUMBER_OPTION_VALUE } from "./optional-number";
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

/**
 * Unified settings schema: single source of truth for types, defaults, and UI placement.
 * The Settings singleton provides type-safe path-based access (`get`/`set`).
 */

// ═══════════════════════════════════════════════════════════════════════════
// Schema Definition Types
// ═══════════════════════════════════════════════════════════════════════════

export type SettingTab =
	| "global"
	| "appearance"
	| "model"
	| "interaction"
	| "resources"
	| "context"
	| "rules"
	| "memory"
	| "files"
	| "shell"
	| "tools"
	| "tasks"
	| "subagents"
	| "providers"
	| "experimental";

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
	global: ["Profiles", "Credentials", "Auth Broker"],
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
		"Grep & Browser",
		"GitHub",
		"Output Limits",
		"Execution",
		"Discovery & MCP",
		"Developer",
	],
	tasks: ["Modes", "Commands & Skills"],
	subagents: ["Delegation", "Subagents", "Limits", "Auto Close", "Isolation", "Coordination"],
	providers: ["Accounts", "Services", "Discovery", "Fireworks", "Tiny Model", "Protocol", "Timeouts", "Privacy"],
	experimental: ["Argot", "Tool Calling", "Auto-Learn"],
};

/** Status line segment identifiers */
export type StatusLineSegmentId =
	| "pi"
	| "model"
	| "account"
	| "secrets"
	| "mode"
	| "path"
	| "git"
	| "pr"
	| "subagents"
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

/** Submenu choice metadata. */
export type SubmenuOption<V extends string = string> = {
	value: V;
	label: string;
	description?: string;
};

interface UiBase {
	tab: SettingTab;
	/** Section within the tab; must be listed in TAB_GROUPS[tab]. Ungrouped settings render at the top. */
	group?: string;
	label: string;
	description: string;
	/** Condition function name - setting only shown when true */
	condition?: string;
	/** When true, the setting renders inside the tab's collapsed "Advanced" fold instead of its normal group. */
	advanced?: boolean;
	/**
	 * Machine-written state excluded from the settings UI while retaining schema metadata.
	 * Used for internal state like `onboardingVersion`.
	 */
	hidden?: boolean;
	/**
	 * Search keywords matching user terms not present in the label (e.g. "reasoning" for effort).
	 * Weighted alongside labels during settings search.
	 */
	keywords?: readonly string[];
	/**
	 * Persistence scope ("global" for cross-profile `~/.veyyon/config.yml`, omitted for profile config).
	 * Global settings display a "Global" badge in the UI.
	 */
	scope?: "global";
}

interface UiBoolean extends UiBase {}

interface UiEnum<T extends readonly string[]> extends UiBase {
	/** Submenu options. When omitted, the enum renders as an inline toggle derived from `values`. */
	options?: ReadonlyArray<SubmenuOption<T[number]>>;
}

interface UiNumber extends UiBase {
	/**
	 * Submenu options for discrete selections.
	 * Number settings without options render as free-form numeric input fields.
	 */
	options?: ReadonlyArray<SubmenuOption>;
	/**
	 * Inclusive numeric bounds enforced during text-box input and printed in reference docs.
	 */
	min?: number;
	max?: number;
}

interface UiString extends UiBase {
	/**
	 * Submenu options.
	 *  - Array  → submenu with these choices.
	 *  - "runtime" → submenu populated by the runtime layer (theme registry, etc.).
	 *  - Omitted → renders as a free text input.
	 */
	options?: ReadonlyArray<SubmenuOption> | "runtime";
}

/** Wide ui shape exposed to consumers that walk the schema generically. */
export type AnyUiMetadata = UiBase & {
	options?: ReadonlyArray<SubmenuOption> | "runtime";
	min?: number;
	max?: number;
};

/**
 * Fields every setting definition shares, whatever its type.
 */
interface SettingDefBase {
	/**
	 * Superseding setting key for retired settings.
	 * Hides the retired key from UI listings while preserving backward-compatible reads.
	 */
	retiredBy?: string;
}

interface BooleanDef extends SettingDefBase {
	type: "boolean";
	default: boolean | undefined;
	ui?: UiBoolean;
}

interface StringDef extends SettingDefBase {
	type: "string";
	default: string | undefined;
	ui?: UiString;
}

/**
 * Ordered chain of model patterns, accepting either comma-separated strings or string arrays.
 * Normalized uniformly across CLI flags, UI fields, and YAML configuration.
 */
interface ModelChainDef extends SettingDefBase {
	type: "modelChain";
	default: string | string[] | undefined;
	ui?: UiString;
}

interface NumberDef extends SettingDefBase {
	type: "number";
	default: number | undefined;
	ui?: UiNumber;
}

interface EnumDef<T extends readonly string[]> extends SettingDefBase {
	type: "enum";
	values: T;
	default: T[number];
	ui?: UiEnum<T>;
}

interface ArrayDef<T> extends SettingDefBase {
	type: "array";
	default: T[];
	ui?: UiBase;
}

interface RecordDef<T> extends SettingDefBase {
	type: "record";
	default: Record<string, T>;
	/**
	 * Per-entry validation hook for record settings with structured key/value shapes.
	 * Executed during type mismatch checks to surface actionable file errors.
	 */
	validateEntry?: (key: string, value: unknown) => string | undefined;
	ui?: UiBase;
}

type SettingDef =
	| BooleanDef
	| StringDef
	| ModelChainDef
	| NumberDef
	| EnumDef<readonly string[]>
	| ArrayDef<unknown>
	| RecordDef<unknown>;

/** The `type` tag a setting definition carries. */
export type SettingType = SettingDef["type"];

/**
 * Exhaustive compile-time record of all valid {@link SettingType} tags.
 * Prevents schema test drift when adding or removing setting kinds.
 */
const SETTING_TYPE_ROWS: Readonly<Record<SettingType, true>> = {
	boolean: true,
	string: true,
	modelChain: true,
	number: true,
	enum: true,
	array: true,
	record: true,
};

/** Every type tag a setting can carry, in declaration order. */
export const SETTING_TYPES = Object.keys(SETTING_TYPE_ROWS) as readonly SettingType[];

/** True when `value` is a type tag the schema actually uses. */
export function isSettingType(value: string): value is SettingType {
	return Object.hasOwn(SETTING_TYPE_ROWS, value);
}

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
 * Mapping of domain slice files to settings objects.
 * Maintained alongside the schema spread for domain composition test validation.
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

export const SETTINGS_SCHEMA = {
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
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Type Inference
// ═══════════════════════════════════════════════════════════════════════════

type Schema = typeof SETTINGS_SCHEMA;

/** All valid setting paths */
export type SettingPath = keyof Schema;

/**
 * Distributive type resolving the value type for a given settings path union.
 */
export type SettingValue<P extends SettingPath> = P extends SettingPath ? SettingValueFor<P> : never;

type SettingValueFor<P extends SettingPath> = Schema[P] extends { type: "boolean"; default: undefined }
	? boolean | undefined
	: Schema[P] extends { type: "boolean" }
		? boolean
		: Schema[P] extends { type: "modelChain" }
			? string | string[] | undefined
			: Schema[P] extends { type: "string" }
				? string | undefined
				: Schema[P] extends { type: "number"; default: undefined }
					? number | undefined
					: Schema[P] extends { type: "number" }
						? number
						: Schema[P] extends { type: "enum"; values: infer V }
							? V extends readonly string[]
								? V[number]
								: never
							: Schema[P] extends { type: "array"; default: infer D }
								? D
								: Schema[P] extends { type: "record"; default: infer D }
									? D
									: never;

/** Get the default value for a setting path */
export function getDefault<P extends SettingPath>(path: P): SettingValue<P> {
	return SETTINGS_SCHEMA[path].default as SettingValue<P>;
}

/** Check if a path has UI metadata (should appear in settings panel) */
export function hasUi(path: SettingPath): boolean {
	return "ui" in SETTINGS_SCHEMA[path];
}

/** Get UI metadata for a path (undefined if no UI) */
export function getUi(path: SettingPath): AnyUiMetadata | undefined {
	const def = SETTINGS_SCHEMA[path];
	return "ui" in def ? (def.ui as AnyUiMetadata) : undefined;
}

/** Get all paths for a specific tab */
export function getPathsForTab(tab: SettingTab): SettingPath[] {
	return (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).filter(path => {
		const ui = getUi(path);
		return ui?.tab === tab;
	});
}

/**
 * The key that replaced `path`, or `undefined` when the setting is current.
 *
 * One place answers "is this key still something to choose?", so the CLI listing,
 * the settings UI, and any future surface cannot disagree about it.
 */
export function retiredBy(path: SettingPath): string | undefined {
	if (!(path in SETTINGS_SCHEMA)) return undefined;
	const def = SETTINGS_SCHEMA[path] as { retiredBy?: string };
	return def.retiredBy;
}

/**
 * Type guard verifying whether a string is a registered {@link SettingPath}.
 * Single validation point across CLI, file loading, and test overlays.
 */
export function isSettingPath(path: string): path is SettingPath {
	return path in SETTINGS_SCHEMA;
}

/** Get the type of a setting */
export function getType(path: SettingPath): SettingType {
	return SETTINGS_SCHEMA[path].type;
}

/** What a value actually is, in the vocabulary the schema uses for types. */
function describeValueType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

/**
 * Explains why `value` is invalid for `path`, or returns `undefined` if valid.
 * Produces actionable mismatch messages naming expected types and allowed enum values.
 */
export function describeSettingTypeMismatch(path: string, value: unknown): string | undefined {
	// Read structurally rather than as `SettingDef`: the schema's literal entries
	// carry readonly defaults (`readonly ["interactive"]`), which are not
	// assignable to the mutable shapes in that union. Only `type` and `values` are
	// needed here, and both are safe to read from the literal.
	const def = (
		SETTINGS_SCHEMA as unknown as Record<
			string,
			| {
					type?: string;
					values?: readonly string[];
					validateEntry?: (key: string, value: unknown) => string | undefined;
			  }
			| undefined
		>
	)[path];
	if (def?.type === undefined || value === undefined) return undefined;

	const found = describeValueType(value);
	const mismatch = (expected: string): string =>
		`${path}: expected ${expected}, found ${found} (${JSON.stringify(value)})`;

	switch (def.type) {
		case "boolean":
			return typeof value === "boolean" ? undefined : mismatch("a boolean (true or false)");
		case "number":
			// NaN and the infinities are numbers to `typeof` and poison every
			// comparison they reach, so they are rejected with the non-numbers.
			return typeof value === "number" && Number.isFinite(value) ? undefined : mismatch("a finite number");
		case "string":
			return typeof value === "string" ? undefined : mismatch("a string");
		case "modelChain":
			// Both encodings of one chain. A list of models is the readable way to
			// write one and the way the handbook shows it, and a comma string is what
			// a CLI flag and the settings text box produce, so refusing either would
			// refuse a config the runtime reads correctly. An array with a non-string
			// in it is still wrong, and saying so names the element.
			if (typeof value === "string") return undefined;
			if (Array.isArray(value)) {
				const bad = value.findIndex(entry => typeof entry !== "string");
				return bad === -1
					? undefined
					: `${path}: expected model patterns, found ${describeValueType(value[bad])} at index ${bad} (${JSON.stringify(value)})`;
			}
			return mismatch("a model pattern, or a list of them");
		case "enum": {
			const values = def.values ?? [];
			if (typeof value === "string" && values.includes(value)) return undefined;
			return `${path}: expected one of ${values.join(", ")}, found ${JSON.stringify(value)}`;
		}
		case "array":
			return Array.isArray(value) ? undefined : mismatch("an array");
		case "record": {
			if (!isRecord(value)) return mismatch("an object");
			// A map whose entries carry a shape of their own (e.g. the
			// depth-keyed model chains of `subagent.modelByDepth`) names the
			// offending entry; the entries that are fine keep working.
			if (def.validateEntry === undefined) return undefined;
			for (const [key, entry] of Object.entries(value)) {
				const reason = def.validateEntry(key, entry);
				if (reason !== undefined) return reason;
			}
			return undefined;
		}
		default:
			return undefined;
	}
}

/**
 * Returns true if `path` is a numeric setting offering the shared unset default option.
 * Derived dynamically from schema submenu options.
 */
export function isUnsetNumberPath(path: SettingPath): boolean {
	// Synthetic UI ids (e.g. the default-model row) are not schema paths; asking
	// about one is legitimate from the selector, so answer instead of throwing.
	if (!(path in SETTINGS_SCHEMA)) return false;
	if (getType(path) !== "number") return false;
	const options = getUi(path)?.options;
	if (!options || options === "runtime") return false;
	return options.some(option => option.value === UNSET_NUMBER_OPTION_VALUE);
}

export function getEnumValues(path: SettingPath): readonly string[] | undefined {
	const def = SETTINGS_SCHEMA[path];
	return "values" in def ? (def.values as readonly string[]) : undefined;
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
	 * Filters active profile skills by skill name.
	 * Skills load from profile agent dir, managed auto-learn, and installed plugins.
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
 * Type mapping for all `statusLine.*` settings, derived dynamically from the schema.
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
