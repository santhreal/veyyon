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

export type TabMetadata = { label: string; icon: `tab.${string}` };

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

export type SubmenuOption<V extends string = string> = {
	value: V;
	label: string;
	description?: string;
};

interface UiBase {
	tab: SettingTab;
	group?: string;
	label: string;
	description: string;
	condition?: string;
	advanced?: boolean;
	hidden?: boolean;
	keywords?: readonly string[];
	scope?: "global";
}

interface UiBoolean extends UiBase {}

interface UiEnum<T extends readonly string[]> extends UiBase {
	options?: ReadonlyArray<SubmenuOption<T[number]>>;
}

interface UiNumber extends UiBase {
	options?: ReadonlyArray<SubmenuOption>;
	min?: number;
	max?: number;
}

interface UiString extends UiBase {
	options?: ReadonlyArray<SubmenuOption> | "runtime";
}

export type AnyUiMetadata = UiBase & {
	options?: ReadonlyArray<SubmenuOption> | "runtime";
	min?: number;
	max?: number;
};

interface SettingDefBase {
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

export type SettingType = SettingDef["type"];

const SETTING_TYPE_ROWS: Readonly<Record<SettingType, true>> = {
	boolean: true,
	string: true,
	modelChain: true,
	number: true,
	enum: true,
	array: true,
	record: true,
};

export function isSettingType(value: string): value is SettingType {
	return Object.hasOwn(SETTING_TYPE_ROWS, value);
}

export interface ModelTagDef {
	name: string;
	color?: string;
	hidden?: boolean;
}

export interface ModelTagsSettings {
	[key: string]: ModelTagDef;
}

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

type Schema = typeof SETTINGS_SCHEMA;

export type SettingPath = keyof Schema;

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

export function getDefault<P extends SettingPath>(path: P): SettingValue<P> {
	return SETTINGS_SCHEMA[path].default as SettingValue<P>;
}

export function hasUi(path: SettingPath): boolean {
	return "ui" in SETTINGS_SCHEMA[path];
}

export function getUi(path: SettingPath): AnyUiMetadata | undefined {
	const def = SETTINGS_SCHEMA[path];
	return "ui" in def ? (def.ui as AnyUiMetadata) : undefined;
}

export function getPathsForTab(tab: SettingTab): SettingPath[] {
	return (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).filter(path => {
		const ui = getUi(path);
		return ui?.tab === tab;
	});
}

export function retiredBy(path: SettingPath): string | undefined {
	if (!(path in SETTINGS_SCHEMA)) return undefined;
	const def = SETTINGS_SCHEMA[path] as { retiredBy?: string };
	return def.retiredBy;
}

export function isSettingPath(path: string): path is SettingPath {
	return path in SETTINGS_SCHEMA;
}

export function getType(path: SettingPath): SettingType {
	return SETTINGS_SCHEMA[path].type;
}

function describeValueType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

export function describeSettingTypeMismatch(path: string, value: unknown): string | undefined {
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
			return typeof value === "number" && Number.isFinite(value) ? undefined : mismatch("a finite number");
		case "string":
			return typeof value === "string" ? undefined : mismatch("a string");
		case "modelChain":
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

export function isUnsetNumberPath(path: SettingPath): boolean {
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

export type StatusLinePreset = SettingValue<"statusLine.preset">;

export type StatusLineSeparatorStyle = SettingValue<"statusLine.separator">;

export type TreeFilterMode = SettingValue<"treeFilterMode">;

export type Personality = SettingValue<"personality">;

export interface CompactionSettings {
	enabled: boolean;
	strategy: "summary";
	threshold: string;
	thresholdPercent: number;
	thresholdTokens: number;
	model?: string;
	reserveTokens: number | undefined;
	keepRecentTokens: number;
	midTurnEnabled: boolean;
	handoffSaveToDisk: boolean;
	autoContinue: boolean;
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

export interface BranchSummarySettings {
	enabled: boolean;
	reserveTokens: number;
}

export interface SkillsSettings {
	enabled?: boolean;
	enableSkillCommands?: boolean;
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
	builtinRules?: boolean;
	disabledRules?: string[];
	experimentalRules?: string[];
}

export interface ExaSettings {
	enabled: boolean;
	enableSearch: boolean;
	searchDelayMs: number;
	enableResearcher: boolean;
	enableWebsets: boolean;
}

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
	writeGraceMinutes: number;
}

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
