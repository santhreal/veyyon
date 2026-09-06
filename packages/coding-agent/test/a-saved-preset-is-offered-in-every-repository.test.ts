/**
 * WHY: loop presets define reusable configurations across repositories (breadth,
 * attempts, review certification, per-arm models, and iteration caps). The two
 * built-in presets (swarm, wide) are immutable baselines that cannot be
 * deleted or overwritten. User-defined presets are stored in a centralized JSON
 * file so they are available in every workspace.
 *
 * The class this closes is preset corruption, accidental deletion or modification
 * of built-in presets, unhandled corrupt or version-mismatched preset JSON files,
 * out-of-bounds numeric settings loaded from disk, and inaccurate preset matching
 * against live loop setups.
 *
 * What it does not catch: multi-process file locking contention during concurrent
 * preset writes across simultaneous CLI instances.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	BUILTIN_PRESETS,
	deletePreset,
	type LoopPreset,
	loadPresets,
	presetMatches,
	savePreset,
} from "@veyyon/coding-agent/autoresearch/presets";
import { MAX_ATTEMPTS, MAX_BREADTH, MIN_ATTEMPTS, MIN_SWARM_BREADTH } from "@veyyon/coding-agent/autoresearch/swarm";
import { TempDir } from "@veyyon/utils";

describe("a saved preset is offered in every repository", () => {
	let tempDir: TempDir;
	let presetFile: string;

	beforeEach(() => {
		tempDir = TempDir.createSync("presets-test-");
		presetFile = path.join(tempDir.path(), "presets.json");
	});

	afterEach(() => {
		tempDir.removeSync();
	});

	it("returns exactly the built-in presets in order on a missing file", () => {
		const loaded = loadPresets(presetFile);
		expect(loaded).toEqual([...BUILTIN_PRESETS]);
		expect(loaded.map(p => p.name)).toEqual(["swarm", "wide"]);
		expect(loaded.every(p => p.builtin)).toBe(true);
	});

	it("saves a preset and loads built-ins followed by saved ones sorted alphabetically", () => {
		const presetZ: Omit<LoopPreset, "builtin"> = {
			name: "zeta-loop",
			breadth: 4,
			attempts: 2,
			certify: true,
			armModels: ["sonnet", "gpt-5"],
			maxIterations: 50,
		};
		const presetA: Omit<LoopPreset, "builtin"> = {
			name: "alpha-loop",
			breadth: 2,
			attempts: 1,
			certify: false,
			armModels: [],
			maxIterations: null,
		};

		expect(savePreset(presetZ, presetFile)).toBe("saved");
		expect(savePreset(presetA, presetFile)).toBe("saved");

		const loaded = loadPresets(presetFile);
		expect(loaded.map(p => p.name)).toEqual(["swarm", "wide", "alpha-loop", "zeta-loop"]);

		const savedAlpha = loaded.find(p => p.name === "alpha-loop");
		expect(savedAlpha).toEqual({ ...presetA, builtin: false });

		const savedZeta = loaded.find(p => p.name === "zeta-loop");
		expect(savedZeta).toEqual({ ...presetZ, builtin: false });
	});

	it("replaces an existing saved preset when saved under the same name", () => {
		const initial: Omit<LoopPreset, "builtin"> = {
			name: "fast-trial",
			breadth: 2,
			attempts: 1,
			certify: false,
			armModels: [],
			maxIterations: 10,
		};
		expect(savePreset(initial, presetFile)).toBe("saved");

		const updated: Omit<LoopPreset, "builtin"> = {
			name: "fast-trial",
			breadth: 4,
			attempts: 3,
			certify: true,
			armModels: ["sonnet"],
			maxIterations: 20,
		};
		expect(savePreset(updated, presetFile)).toBe("saved");

		const loaded = loadPresets(presetFile);
		const saved = loaded.find(p => p.name === "fast-trial");
		expect(saved).toEqual({ ...updated, builtin: false });
		expect(loaded.filter(p => p.name === "fast-trial")).toHaveLength(1);
	});

	it("refuses to overwrite a built-in preset and writes nothing to disk", () => {
		const overwriteSwarm: Omit<LoopPreset, "builtin"> = {
			name: "swarm",
			breadth: 8,
			attempts: 5,
			certify: true,
			armModels: ["gpt-5"],
			maxIterations: 100,
		};

		const result = savePreset(overwriteSwarm, presetFile);
		expect(result).toBe("builtin");
		expect(fs.existsSync(presetFile)).toBe(false);

		const loaded = loadPresets(presetFile);
		expect(loaded).toEqual([...BUILTIN_PRESETS]);
	});

	it("deletes a saved preset and refuses to delete built-in or unknown names", () => {
		const custom: Omit<LoopPreset, "builtin"> = {
			name: "temporary",
			breadth: 2,
			attempts: 1,
			certify: false,
			armModels: [],
			maxIterations: null,
		};
		savePreset(custom, presetFile);
		expect(loadPresets(presetFile).some(p => p.name === "temporary")).toBe(true);

		// Deleting saved preset succeeds
		expect(deletePreset("temporary", presetFile)).toBe(true);
		expect(loadPresets(presetFile).some(p => p.name === "temporary")).toBe(false);

		// Deleting already deleted or nonexistent preset returns false
		expect(deletePreset("temporary", presetFile)).toBe(false);
		expect(deletePreset("unknown-preset", presetFile)).toBe(false);

		// Deleting a built-in preset returns false and leaves built-in intact
		expect(deletePreset("swarm", presetFile)).toBe(false);
		expect(loadPresets(presetFile).some(p => p.name === "swarm" && p.builtin)).toBe(true);
	});

	it("ignores malformed JSON, wrong version, or invalid records without throwing", () => {
		// Invalid JSON
		fs.writeFileSync(presetFile, "{ this is not json }");
		expect(loadPresets(presetFile)).toEqual([...BUILTIN_PRESETS]);

		// Wrong version
		fs.writeFileSync(presetFile, JSON.stringify({ version: 2, presets: [] }));
		expect(loadPresets(presetFile)).toEqual([...BUILTIN_PRESETS]);

		// presets not an array
		fs.writeFileSync(presetFile, JSON.stringify({ version: 1, presets: "not-array" }));
		expect(loadPresets(presetFile)).toEqual([...BUILTIN_PRESETS]);

		// Array containing records missing required fields
		const mixedPresets = [
			{ name: "valid-one", breadth: 2, attempts: 1, certify: true, armModels: [], maxIterations: null },
			{ name: "missing-certify", breadth: 2, attempts: 1, armModels: [] },
			{ name: 123, breadth: 2, attempts: 1, certify: true, armModels: [] },
		];
		fs.writeFileSync(presetFile, JSON.stringify({ version: 1, presets: mixedPresets }));
		const loaded = loadPresets(presetFile);
		expect(loaded.some(p => p.name === "valid-one")).toBe(true);
		expect(loaded.some(p => p.name === "missing-certify")).toBe(false);
	});

	it("clamps out-of-range breadth and attempts on load", () => {
		const outOfRange = [
			{ name: "clamped-low", breadth: 0, attempts: 0, certify: true, armModels: [], maxIterations: null },
			{ name: "clamped-high", breadth: 99, attempts: 50, certify: false, armModels: [], maxIterations: null },
		];
		fs.writeFileSync(presetFile, JSON.stringify({ version: 1, presets: outOfRange }));

		const loaded = loadPresets(presetFile);
		const low = loaded.find(p => p.name === "clamped-low");
		expect(low?.breadth).toBe(MIN_SWARM_BREADTH);
		expect(low?.attempts).toBe(MIN_ATTEMPTS);

		const high = loaded.find(p => p.name === "clamped-high");
		expect(high?.breadth).toBe(MAX_BREADTH);
		expect(high?.attempts).toBe(MAX_ATTEMPTS);
	});

	it("matches setup accurately with presetMatches on all configuration fields", () => {
		const preset: LoopPreset = {
			name: "custom",
			breadth: 3,
			attempts: 2,
			certify: true,
			armModels: ["sonnet", "gpt-5"],
			maxIterations: 25,
			builtin: false,
		};

		const exactSetup = {
			breadth: 3,
			attempts: 2,
			certify: true,
			armModels: ["sonnet", "gpt-5"],
			maxIterations: 25,
		};
		expect(presetMatches(preset, exactSetup)).toBe(true);

		// Whitespace in arm models is trimmed during comparison
		expect(presetMatches(preset, { ...exactSetup, armModels: [" sonnet ", "gpt-5"] })).toBe(true);

		// Differing breadth
		expect(presetMatches(preset, { ...exactSetup, breadth: 4 })).toBe(false);

		// Differing attempts
		expect(presetMatches(preset, { ...exactSetup, attempts: 1 })).toBe(false);

		// Differing certify
		expect(presetMatches(preset, { ...exactSetup, certify: false })).toBe(false);

		// Differing maxIterations
		expect(presetMatches(preset, { ...exactSetup, maxIterations: null })).toBe(false);
		expect(presetMatches(preset, { ...exactSetup, maxIterations: 50 })).toBe(false);

		// Differing arm models
		expect(presetMatches(preset, { ...exactSetup, armModels: ["sonnet", "glm"] })).toBe(false);
		expect(presetMatches(preset, { ...exactSetup, armModels: ["sonnet"] })).toBe(false);
	});
});
