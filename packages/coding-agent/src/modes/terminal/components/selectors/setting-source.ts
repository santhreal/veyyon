/**
 * Which configuration layer supplies a setting, and a record setting's entries.
 *
 * `/settings` writes the profile layer. A `--config` file and a runtime override
 * sit above it, so a profile write under either changes nothing the session reads.
 * A scalar has one value and therefore one source. A record holds independent
 * entries that the store deep-merges layer by layer, so one entry can come from
 * a runtime override while its siblings still come from the profile. These
 * helpers answer per entry, and give the record a profile write starts from so
 * an override is never copied into the profile file.
 */
import { isRecord } from "@veyyon/utils";
import { type SettingSource, settings } from "../../../../config/settings";
import { getType, isSettingPath, type SettingPath } from "../../../../config/settings-schema";

export const SETTING_SOURCE_LABELS: Record<SettingSource, string> = {
	default: "default",
	profile: "profile",
	"config-file": "--config file",
	runtime: "runtime override",
	global: "global config",
};

/** Layers checked for one record entry, highest precedence first. */
const ENTRY_LAYERS = ["runtime", "config-file", "profile"] as const;

/** True for a layer that shadows the profile, so a profile write under it has no effect. */
export function isOverrideSource(source: SettingSource): boolean {
	return source === "config-file" || source === "runtime";
}

/** True for a declared setting whose value is a record of independent entries. */
export function isRecordSetting(path: string): path is SettingPath {
	return isSettingPath(path) && getType(path) === "record";
}

/** The highest-precedence layer that supplies `key` inside the record setting at `path`. */
export function recordEntrySource(path: SettingPath, key: string): SettingSource {
	const segments = [...path.split("."), key];
	for (const layer of ENTRY_LAYERS) {
		if (settings.layerValue(layer, segments) !== undefined) return layer;
	}
	return "default";
}

/**
 * The record a profile write of one entry starts from.
 *
 * With no override on the path the effective value is the profile value (or the
 * schema default), so that is returned. With an override, the effective value
 * mixes in entries the profile does not hold; writing it back would copy them
 * into the profile, so only the profile layer's own record is returned.
 */
export function profileWritableRecord(path: SettingPath): unknown {
	if (!isOverrideSource(settings.getSource(path))) return settings.get(path);
	return settings.layerValue("profile", path.split("."));
}

/** The entries of a record setting that an override layer supplies, in key order. */
export function overriddenRecordEntries(path: SettingPath): Array<{ key: string; source: SettingSource }> {
	const segments = path.split(".");
	const keys = new Set<string>();
	for (const layer of ["runtime", "config-file"] as const) {
		const value = settings.layerValue(layer, segments);
		if (isRecord(value)) {
			for (const key of Object.keys(value)) keys.add(key);
		}
	}
	return Array.from(keys)
		.sort((a, b) => a.localeCompare(b))
		.map(key => ({ key, source: recordEntrySource(path, key) }));
}

/**
 * Sentences naming the record entries an override layer supplies, or
 * `undefined` when none does. Leads the description of the record row and of a
 * record editor that edits the whole value as text.
 */
export function overriddenEntriesNote(path: SettingPath): string | undefined {
	const entries = overriddenRecordEntries(path);
	if (entries.length === 0) return undefined;
	const bySource = new Map<SettingSource, string[]>();
	for (const { key, source } of entries) {
		const keys = bySource.get(source) ?? [];
		keys.push(key);
		bySource.set(source, keys);
	}
	const parts = Array.from(
		bySource,
		([source, keys]) => `Set by ${SETTING_SOURCE_LABELS[source]}: ${keys.join(", ")}.`,
	);
	return `${parts.join(" ")} Those entries take precedence over the profile.`;
}

/** Suffix for one entry row whose value an override layer supplies. */
export function overriddenEntryLabel(source: SettingSource): string {
	return `${SETTING_SOURCE_LABELS[source]} · read-only`;
}
