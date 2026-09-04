/**
 * What a setting declares about itself, without saying what stores it or what draws it.
 *
 * A setting is declared once, by whichever package owns the behaviour it controls: its type, its
 * default, and where a host places it. The store that reads a config file and the panel that draws a
 * row both consume that declaration; neither is named here. A declaration that imported the store
 * would tie every plugin's settings to one config format, and one that imported the panel would tie
 * them to one host, which is the coupling this package removes.
 *
 * The shapes are measured, not invented: they are the definitions every domain slice of the
 * product's settings schema already writes, and the `ui` block is what the settings panel already
 * reads. A `condition` is the NAME of a predicate a host registers, so a declaration can hide a
 * dependent knob behind its master toggle without holding a function that needs the store to answer.
 */

/**
 * The tab a declared setting is placed under.
 *
 * The vocabulary is shared between the package that declares a setting and the host that draws the
 * panel: a declaration names a tab, a host lays the tabs out and labels them. Which tabs exist is
 * therefore part of the contract; their order, labels and icons are the host's.
 */
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
	/**
	 * Per-entry validation for a map whose keys or values carry a shape the
	 * bare `record` type cannot express. Declared by the owning domain and run
	 * from {@link describeSettingTypeMismatch}, so a hand-edited entry that can
	 * never take effect is reported with its file rather than sitting in the
	 * map looking configured.
	 */
	validateEntry?: (key: string, value: unknown) => string | undefined;
	ui?: UiBase;
}

/** One declared setting: its type tag, its default, and the optional `ui` block a host reads. */
export type SettingDef =
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
