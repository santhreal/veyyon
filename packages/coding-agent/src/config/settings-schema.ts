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
	context: ["General", "Prompt cache", "Session instrumentation"],
	rules: ["Rules", "Stream interrupts (TTSR)"],
	memory: ["General", "Mnemopi", "Hindsight"],
	files: ["Editing", "Reading", "Read Summaries", "LSP"],
	shell: ["Bash", "Eval & Runtimes"],
	tools: [
		"Available Tools",
		"Todos",
		"Grep & Browser",
		"GitHub",
		"Output Limits",
		"Execution",
		"Discovery & MCP",
		"Developer",
	],
	tasks: ["Modes", "Commands & Skills"],
	subagents: ["Delegation", "Agents", "Models", "Limits", "Auto Close", "Isolation", "Coordination"],
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
	 * Machine-written state that must NOT be a row, even though it declares a `ui`
	 * block for its label, description and generated-reference entry.
	 *
	 * Exactly one setting needs this: `onboardingVersion`, the setup generation this
	 * machine has completed. It was kept out of the panel by an accident instead of a
	 * declaration: `pathToSettingDef` dropped every optionless number, and the global
	 * domain's own header cited that drop as the reason a non-knob was safe to declare.
	 * Once an optionless number renders, that hiding place is gone, and an operator
	 * typing 3 into "Onboarding Version" would skip setup or re-run it.
	 *
	 * So the intent is written down. This is a sibling of `condition` and `advanced`,
	 * which already decide where and whether a declared row appears; it is not a new
	 * way to hide a knob, and the reachability contract counts a hidden row as not
	 * claiming a place on the surface.
	 */
	hidden?: boolean;
	/**
	 * Words a user would type looking for this setting that its label does not
	 * contain: "reasoning" for effort, "clipboard" for copy, "wrap" for soft
	 * wrapping. Search weights these like the label, because to the person typing
	 * they ARE the name. Living next to the setting keeps the vocabulary in one
	 * place instead of a lookup table that drifts as labels change.
	 */
	keywords?: readonly string[];
	/**
	 * Persistence scope. Omitted or "profile": the value lives in the active
	 * profile's `agent/config.yml`. "global": the value is cross-profile and lives
	 * in `~/.veyyon/config.yml`; reads and writes route through a matching entry in
	 * GLOBAL_SETTING_BINDINGS (settings-domains/global.ts) rather than the profile
	 * store, so there is exactly one owner for the value. The settings UI shows a
	 * "Global" badge for these.
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
	 * Submenu options. Without options the setting renders as a free text box, the
	 * same control `string`, `record` and `array` already fall back to. It used to
	 * render as NOTHING: `pathToSettingDef` returned null for an optionless number,
	 * so fifteen settings carrying a full `ui` block, label and description were
	 * unreachable from /settings while `getPathsForTab` still counted them. A `ui`
	 * block is the declaration that a setting is meant to be shown; dropping one
	 * silently is the bug, whatever the count of options.
	 */
	options?: ReadonlyArray<SubmenuOption>;
	/**
	 * Inclusive bounds, enforced when the value is typed into the text box.
	 *
	 * Declared here rather than assumed at the input, so the constraint lives with
	 * the setting and the generated reference can print it. A setting with no bound
	 * accepts any finite number: the input refuses `abc`, `1e400` and a blank that
	 * is not a clear, and refuses nothing else it was not told to refuse.
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
	 * The key it was replaced by, when this setting is superseded.
	 *
	 * A retired key stays in the schema so an existing config keeps working and a
	 * migration can read it, but it is no longer something to choose: it is hidden
	 * from `config list` and from the settings UI, and `config get`/`set` name the
	 * replacement. Without this marker a superseded key kept advertising itself as
	 * settable next to the key that replaced it, which is the confusion the
	 * supersession was meant to end.
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
 * An ORDERED CHAIN of model patterns, written either way.
 *
 * `"opus,sonnet"` and `["opus", "sonnet"]` are the same chain, and every reader
 * goes through `normalizeModelPatternList`, which splits a comma string and
 * flattens a list into the same array. The comma string is what a CLI flag and
 * the settings text box produce; the YAML list is what a hand-written config
 * uses, because a list of models reads as a list.
 *
 * This type exists because declaring the setting a `string` made the validator
 * disagree with every reader: a config written as a list was reported as a value
 * that "does not match its declared type" and shown as invalid, while the runtime
 * read it perfectly well. The docs show the list form for `subagent.model`, so the
 * documented spelling was the one being flagged.
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
 * The same tags as data, with one row per kind.
 *
 * A corpus test walks the schema at runtime and has to know which tags are real,
 * and the list it kept of its own drifted both ways: it named an `"object"` kind
 * the schema never had, and it did not name `"modelChain"` the day that kind
 * arrived. `Record<SettingType, true>` is what stops that. Adding a definition
 * kind without a row here is a compile error, and a row for a kind that does not
 * exist is a compile error too.
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

/** Infer the value type for a setting path */
/**
 * The value type behind a settings path.
 *
 * The outer `P extends SettingPath` is what makes this DISTRIBUTE. Without it,
 * passing the whole `SettingPath` union (which is what a generic walk over the
 * schema does) makes `Schema[P]` a union that matches none of the branches
 * below, so the whole type collapsed to `never` — and a `never` return silently
 * defeats every narrowing at the call site rather than failing where the mistake
 * is. `docs/settings-reference.md`'s generator hit exactly that: its
 * array-default branch was unreachable code the compiler could not warn about
 * usefully.
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
 * Whether an arbitrary string names a real setting.
 *
 * The one place that answers "does veyyon know this key?", and the type guard
 * that turns an untrusted string into a `SettingPath`. Every surface that
 * accepts a key from outside the program asks this: the `config` CLI, a config
 * file, an eval harness staging an overlay. Each one hand-rolling
 * `path in SETTINGS_SCHEMA` is how they drift apart on what counts, and a
 * caller that forgets to ask silently accepts a key nothing will ever read.
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
 * Explain why `value` cannot be the value of `path`, or `undefined` when it can.
 *
 * A settings file is hand-editable, so a wrong type is an ordinary mistake:
 * `autoUpdate: "no"`, `tabWidth: "4"`, a theme name where an object belongs. The
 * danger is that most of those are silently WRONG rather than obviously broken.
 * `"no"` is a truthy string, so a boolean setting a user clearly meant to turn
 * off stays on, and nothing anywhere says why. Detecting the mismatch is what
 * lets the loader say so out loud (Law 10) instead of letting the config lie.
 *
 * The message names the key, what the schema expects, and what was found,
 * because the reader is someone who edited a file and needs to know which line
 * to fix. Enum values are listed for the same reason: "expected one of a, b, c"
 * is actionable where "invalid value" is not.
 *
 * Returns `undefined` for unregistered paths rather than guessing. Subsystems
 * read dotted paths that are not in the schema yet, and inventing a type for
 * those would turn a forward-compatible read into a spurious error.
 */
export function describeSettingTypeMismatch(path: string, value: unknown): string | undefined {
	// Read structurally rather than as `SettingDef`: the schema's literal entries
	// carry readonly defaults (`readonly ["interactive"]`), which are not
	// assignable to the mutable shapes in that union. Only `type` and `values` are
	// needed here, and both are safe to read from the literal.
	const def = (
		SETTINGS_SCHEMA as unknown as Record<string, { type?: string; values?: readonly string[] } | undefined>
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
		case "record":
			return isRecord(value) ? undefined : mismatch("an object");
		default:
			return undefined;
	}
}

/** Get enum values for an enum setting */
/**
 * True when `path` is a numeric setting whose submenu offers the shared unset row,
 * so the UI shows `Default` and stores {@link UNSET_NUMBER}.
 *
 * Derived from the schema rather than listed by hand: the selector used to carry a
 * hardcoded set of three compaction paths, which silently excluded the six sampling
 * settings that spell the same idea, and would have gone stale the moment a new
 * optional numeric setting shipped.
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

export interface StatusLineSettings {
	preset: StatusLinePreset;
	separator: StatusLineSeparatorStyle;
	showHookStatus: boolean;
	leftSegments: StatusLineSegmentId[];
	rightSegments: StatusLineSegmentId[];
	segmentOptions: Record<string, unknown>;
}

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
