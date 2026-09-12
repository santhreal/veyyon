/**
 * The settings schema as the kernel reads it: every setting any package has declared, keyed by
 * its dotted path, and the questions asked of a declaration — its default, its type, its UI block,
 * whether a key is real or retired.
 *
 * The kernel names no setting of its own here. A package that owns a behaviour declares the
 * settings that control it as a table and registers the table through {@link declareSettings};
 * the type side arrives by declaration merging into {@link DeclaredSettings}, so `settings.get`
 * is typed against the union of every registered table while this module stays generic over
 * them. Composition order is the registering package's, and a path declared twice is a defect
 * that {@link declareSettings} rejects rather than resolves by last-write.
 *
 * ```ts
 * export const RESOURCES_SETTINGS = declareSettings({ "session.maxProcesses": { type: "number", default: 64 } } as const);
 * declare module "@veyyon/kernel/settings/schema" {
 *   interface DeclaredSettings extends Schema {} // type Schema = typeof RESOURCES_SETTINGS
 * }
 * ```
 */

import type { AnyUiMetadata, SettingTab, SettingType } from "@veyyon/settings";
import { isRecord } from "@veyyon/utils/type-guards";
import { UNSET_NUMBER_OPTION_VALUE } from "./optional-number";

/**
 * Every declared setting, by declaration merging.
 *
 * Empty here; a package extends it with the type of the table it registered. Reading
 * `keyof DeclaredSettings` inside the kernel yields only what the kernel's own tables declare,
 * which is what lets a kernel module type its reads without naming another package.
 */
export interface DeclaredSettings {
	// Empty by default; a package extends it by declaration merging.
}

/** One declaration as the registry holds it: read structurally, since a table's literal entries carry readonly defaults. */
export interface RegisteredSettingDef {
	type: SettingType;
	default: unknown;
	values?: readonly string[];
	retiredBy?: string;
	ui?: AnyUiMetadata;
	validateEntry?: (key: string, value: unknown) => string | undefined;
}

/** A table of declarations, as a package writes one. */
export type SettingsTable = Record<string, RegisteredSettingDef>;

/** All valid setting paths */
export type SettingPath = keyof DeclaredSettings & string;

/**
 * The value type behind a settings path.
 *
 * The outer `P extends SettingPath` is what makes this DISTRIBUTE. Without it,
 * passing the whole `SettingPath` union (which is what a generic walk over the
 * schema does) makes `DeclaredSettings[P]` a union that matches none of the branches
 * below, so the whole type collapsed to `never` — and a `never` return silently
 * defeats every narrowing at the call site rather than failing where the mistake
 * is. `docs/handbook/src/reference/settings-reference.md`'s generator hit exactly that: its
 * array-default branch was unreachable code the compiler could not warn about
 * usefully.
 */
export type SettingValue<P extends SettingPath> = P extends SettingPath ? SettingValueFor<P> : never;

type SettingValueFor<P extends SettingPath> = DeclaredSettings[P] extends { type: "boolean"; default: undefined }
	? boolean | undefined
	: DeclaredSettings[P] extends { type: "boolean" }
		? boolean
		: DeclaredSettings[P] extends { type: "modelChain" }
			? string | string[] | undefined
			: DeclaredSettings[P] extends { type: "string" }
				? string | undefined
				: DeclaredSettings[P] extends { type: "number"; default: undefined }
					? number | undefined
					: DeclaredSettings[P] extends { type: "number" }
						? number
						: DeclaredSettings[P] extends { type: "enum"; values: infer V }
							? V extends readonly string[]
								? V[number]
								: never
							: DeclaredSettings[P] extends { type: "array"; default: infer D }
								? D
								: DeclaredSettings[P] extends { type: "record"; default: infer D }
									? D
									: never;

const schema: Record<string, RegisteredSettingDef> = {};
let schemaPaths: readonly SettingPath[] = [];

/**
 * Register a package's settings table and hand it back, so the table is one object under two
 * names rather than a copy: the registering package keeps its typed const, and the registry
 * holds the same declarations.
 *
 * A path already registered fails loud. Two packages declaring one key is a defect in whichever
 * arrived second, and resolving it by overwrite would let the panel show one declaration while
 * the store read another.
 */
export function declareSettings<T extends SettingsTable>(table: T): T {
	for (const path of Object.keys(table)) {
		if (Object.hasOwn(schema, path)) {
			throw new Error(`Setting "${path}" is declared twice; a setting has one owner.`);
		}
	}
	try {
		Object.assign(schema, table);
	} finally {
		// Refresh after assignment, including a partial assignment from a throwing accessor.
		schemaPaths = Object.freeze(Object.keys(schema) as SettingPath[]);
	}
	return table;
}

/**
 * Empty the registry, for a test that needs the state before any table has loaded.
 *
 * A table registers at module scope, so it outlives the suite that imported it and the next suite
 * in the same process reads it. One suite pins what an empty registry answers and another declares
 * the table its store reads; each starts from empty so neither depends on the order the runner
 * picked. Never called by a running product, where the registry only grows.
 *
 * @internal
 */
export function resetDeclaredSettingsForTest(): void {
	for (const path of Object.keys(schema)) {
		delete schema[path];
	}
	schemaPaths = [];
}

/**
 * The registry, or a loud failure when nothing has registered.
 *
 * The tables arrive by import: a package's schema module calls {@link declareSettings} when it
 * loads, so a query issued before any such module has loaded reads an empty registry. Answered
 * quietly, `isSettingPath("compaction.enabled")` is `false` and every key a config names is
 * "unknown", which is a wrong answer that looks like a decision. An empty registry is never the
 * state of a running product, so a query against one is a load-order defect and is reported as one.
 */
function registered(): Record<string, RegisteredSettingDef> {
	if (schemaPaths.length === 0) {
		throw new Error(
			"No settings are declared: the module that composes the settings schema has not loaded. Import it before querying a setting.",
		);
	}
	return schema;
}

/** The declaration behind `path`, or a loud failure naming the path when nothing declared it. */
function declared(path: string): RegisteredSettingDef {
	const def = registered()[path];
	if (def === undefined) {
		throw new Error(`Setting "${path}" is not declared by any loaded settings table.`);
	}
	return def;
}

/** Every registered declaration, keyed by path, in registration order. */
export function settingsSchema(): Readonly<Record<string, RegisteredSettingDef>> {
	return registered();
}

/** An immutable key snapshot; registration or reset replaces it for dependent indexes. */
export function settingsSchemaPaths(): readonly SettingPath[] {
	registered();
	return schemaPaths;
}

/** Get the default value for a setting path */
export function getDefault<P extends SettingPath>(path: P): SettingValue<P> {
	return declared(path).default as SettingValue<P>;
}

/** Check if a path has UI metadata (should appear in settings panel) */
export function hasUi(path: SettingPath): boolean {
	return "ui" in declared(path);
}

/** Get UI metadata for a path (undefined if no UI) */
export function getUi(path: SettingPath): AnyUiMetadata | undefined {
	return declared(path).ui;
}

/** Get all paths for a specific tab */
export function getPathsForTab(tab: SettingTab): SettingPath[] {
	return settingsSchemaPaths().filter(path => {
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
	return registered()[path]?.retiredBy;
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
	return path in registered();
}

/** Get the type of a setting */
export function getType(path: SettingPath): SettingType {
	return declared(path).type;
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
	const def = registered()[path];
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
			// depth-keyed model chains of `agent.modelByDepth`) names the
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
	if (!(path in registered())) return false;
	if (getType(path) !== "number") return false;
	const options = getUi(path)?.options;
	if (!options || options === "runtime") return false;
	return options.some(option => option.value === UNSET_NUMBER_OPTION_VALUE);
}

/** Get enum values for an enum setting */
export function getEnumValues(path: SettingPath): readonly string[] | undefined {
	return declared(path).values;
}
