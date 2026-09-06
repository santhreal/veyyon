/**
 * Named swarm configurations the autoswarm console applies in one keystroke.
 *
 * Two are built in and cannot be changed: the default swarm and a wide one.
 * The rest are the operator's, saved from the console under a name and kept in
 * one JSON file beside the autoresearch databases, so a preset saved in one
 * repository is offered in every other. A preset holds the shape of a swarm and
 * never its goal: the goal is what a session is about, the preset is how hard
 * it searches.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { clamp, getAutoresearchDir } from "@veyyon/utils";
import { MAX_ATTEMPTS, MAX_BREADTH, MIN_ATTEMPTS, MIN_SWARM_BREADTH } from "./swarm";
import type { SwarmSetup } from "./types";

/** The shape of a loop, minus its goal. */
export interface LoopPreset extends SwarmSetup {
	name: string;
	/** Soft iteration cap per segment; null leaves the model to decide. */
	maxIterations: number | null;
	/** Built-in presets are offered in every store and cannot be saved over or deleted. */
	builtin: boolean;
}

export const BUILTIN_PRESETS: readonly LoopPreset[] = [
	{ name: "swarm", breadth: 3, attempts: 1, certify: true, armModels: [], maxIterations: null, builtin: true },
	{ name: "wide", breadth: 5, attempts: 2, certify: true, armModels: [], maxIterations: null, builtin: true },
];

/** Bumped when the on-disk shape changes; a file at another version is ignored, never half-read. */
const PRESET_FILE_VERSION = 1;

interface PresetFile {
	version: number;
	presets: Array<Omit<LoopPreset, "builtin">>;
}

export function presetFilePath(): string {
	const override = process.env.VEYYON_AUTORESEARCH_DB_DIR;
	return path.join(override ?? getAutoresearchDir(), "presets.json");
}

function isPresetRecord(value: unknown): value is Omit<LoopPreset, "builtin"> {
	if (value === null || typeof value !== "object") return false;
	if (!("name" in value && "breadth" in value && "attempts" in value && "certify" in value && "armModels" in value)) {
		return false;
	}
	const maxIterations = "maxIterations" in value ? value.maxIterations : undefined;
	return (
		typeof value.name === "string" &&
		typeof value.breadth === "number" &&
		typeof value.attempts === "number" &&
		typeof value.certify === "boolean" &&
		Array.isArray(value.armModels) &&
		value.armModels.every(entry => typeof entry === "string") &&
		(maxIterations === null || typeof maxIterations === "number")
	);
}

/** Every preset the console offers: the built-ins first, then the saved ones by name. */
export function loadPresets(file = presetFilePath()): LoopPreset[] {
	const saved = readPresetFile(file);
	return [...BUILTIN_PRESETS, ...saved.map(preset => ({ ...preset, builtin: false }))];
}

function readPresetFile(file: string): Array<Omit<LoopPreset, "builtin">> {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	if (parsed === null || typeof parsed !== "object") return [];
	if (!("version" in parsed && "presets" in parsed)) return [];
	if (parsed.version !== PRESET_FILE_VERSION || !Array.isArray(parsed.presets)) return [];
	return parsed.presets.filter(isPresetRecord).map(preset => ({
		name: preset.name,
		breadth: clamp(Math.floor(preset.breadth), MIN_SWARM_BREADTH, MAX_BREADTH),
		attempts: clamp(Math.floor(preset.attempts), MIN_ATTEMPTS, MAX_ATTEMPTS),
		certify: preset.certify,
		armModels: preset.armModels,
		maxIterations: preset.maxIterations,
	}));
}

function writePresetFile(file: string, presets: Array<Omit<LoopPreset, "builtin">>): void {
	const body: PresetFile = { version: PRESET_FILE_VERSION, presets };
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(body, null, "\t")}\n`);
}

/**
 * Save `preset` under its name, replacing a saved preset of the same name. A
 * built-in name is refused: the built-ins are the fixed points the operator's
 * presets are read against.
 */
export function savePreset(preset: Omit<LoopPreset, "builtin">, file = presetFilePath()): "saved" | "builtin" {
	if (BUILTIN_PRESETS.some(entry => entry.name === preset.name)) return "builtin";
	const others = readPresetFile(file).filter(entry => entry.name !== preset.name);
	others.push(preset);
	others.sort((a, b) => a.name.localeCompare(b.name));
	writePresetFile(file, others);
	return "saved";
}

/** Remove a saved preset; a name that is not saved, or is built in, removes nothing. */
export function deletePreset(name: string, file = presetFilePath()): boolean {
	const saved = readPresetFile(file);
	const kept = saved.filter(entry => entry.name !== name);
	if (kept.length === saved.length) return false;
	writePresetFile(file, kept);
	return true;
}

/** Whether `setup` is exactly the preset, so the console can mark the one in force. */
export function presetMatches(preset: LoopPreset, setup: SwarmSetup & { maxIterations: number | null }): boolean {
	return (
		preset.breadth === setup.breadth &&
		preset.attempts === setup.attempts &&
		preset.certify === setup.certify &&
		preset.maxIterations === setup.maxIterations &&
		preset.armModels.map(spec => spec.trim()).join(",") === setup.armModels.map(spec => spec.trim()).join(",")
	);
}
