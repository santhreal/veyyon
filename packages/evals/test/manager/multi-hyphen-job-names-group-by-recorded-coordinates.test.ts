/**
 * WHY:
 * `experiments.ts` previously derived experiment and arm identity by slicing on the
 * first hyphen of the job name, so `deep-swe-baseline` became experiment `deep`, arm
 * `swe-baseline`, and every multi-hyphen run was mis-grouped.
 *
 * It must stop inferring by string splitting: it must read recorded coordinates
 * (explicit fields or config properties) and fall back to the whole job name as a
 * single-arm experiment when no coordinates were recorded, never to a slice.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	armOf,
	buildExperiments,
	canonicalArmOf,
	experimentDetail,
	experimentOf,
	inferRunCoordinates,
	summarizeArm,
} from "../../src/manager/experiments";
import { type RunRow, RunStore } from "../../src/manager/store";

const cleanups: string[] = [];

function makeStoreDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "experiments-coords-test-"));
	cleanups.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of cleanups.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function fakeRun(jobName: string, overrides: Partial<RunRow> = {}): RunRow {
	return {
		schemaVersion: 2,
		suite: "terminal-bench@2.0",
		backend: "harbor",
		benchmark: "harbor",
		jobName,
		experiment: "",
		arm: "",
		dataset: "d",
		agent: "veyyon",
		models: "anthropic/claude-opus-4-8",
		label: "",
		prewalk: null,
		config: {},
		role: "",
		note: "",
		status: "complete",
		pid: null,
		exitCode: 0,
		createdAt: Date.now(),
		finishedAt: Date.now(),
		nTotal: 10,
		done: 10,
		pass: 8,
		fail: 2,
		error: 0,
		running: 0,
		costUsd: null,
		tokIn: 100,
		tokOut: 20,
		tokCache: null,
		score: 0.8,
		metrics: {},
		...overrides,
	};
}

describe("multi-hyphen job names group by recorded coordinates", () => {
	it("correctly groups multi-hyphen runs carrying recorded coordinates", () => {
		const baselineRun = fakeRun("deep-swe-baseline", {
			config: { experiment: "deep-swe", arm: "baseline" },
		});
		const treatmentRun = fakeRun("deep-swe-treatment-variant-1", {
			config: { experiment: "deep-swe", arm: "treatment-variant-1" },
		});

		expect(experimentOf(baselineRun)).toBe("deep-swe");
		expect(armOf(baselineRun)).toBe("baseline");
		expect(inferRunCoordinates(baselineRun)).toEqual({ experiment: "deep-swe", arm: "baseline" });

		expect(experimentOf(treatmentRun)).toBe("deep-swe");
		expect(armOf(treatmentRun)).toBe("treatment-variant-1");
		expect(inferRunCoordinates(treatmentRun)).toEqual({
			experiment: "deep-swe",
			arm: "treatment-variant-1",
		});
	});

	it("falls back to the whole job name for uncoordinated multi-hyphen runs", () => {
		const uncoordinatedMultiHyphen = fakeRun("deep-swe-baseline", { config: {} });

		expect(experimentOf(uncoordinatedMultiHyphen)).toBe("deep-swe-baseline");
		expect(armOf(uncoordinatedMultiHyphen)).toBe("deep-swe-baseline");
		expect(inferRunCoordinates(uncoordinatedMultiHyphen)).toEqual({
			experiment: "deep-swe-baseline",
			arm: "deep-swe-baseline",
		});

		expect(experimentOf("deep-swe-baseline")).toBe("deep-swe-baseline");
		expect(armOf("deep-swe-baseline")).toBe("deep-swe-baseline");
	});

	it("falls back to the whole job name for uncoordinated single-token names with no separators", () => {
		const standaloneRun = fakeRun("standalonename", { config: {} });

		expect(experimentOf(standaloneRun)).toBe("standalonename");
		expect(armOf(standaloneRun)).toBe("standalonename");
		expect(inferRunCoordinates(standaloneRun)).toEqual({
			experiment: "standalonename",
			arm: "standalonename",
		});

		expect(experimentOf("standalonename")).toBe("standalonename");
		expect(armOf("standalonename")).toBe("standalonename");
	});

	it("summarizeArm uses recorded arm or label rather than slicing on hyphen", () => {
		const runWithCoords = fakeRun("deep-swe-baseline", {
			config: { experiment: "deep-swe", arm: "baseline" },
		});
		const summaryWithCoords = summarizeArm(runWithCoords, []);
		expect(summaryWithCoords.arm).toBe("baseline");
		expect(summaryWithCoords.recordedArm).toBe("baseline");

		const uncoordinatedRun = fakeRun("deep-swe-baseline", { config: {} });
		const summaryUncoordinated = summarizeArm(uncoordinatedRun, []);
		expect(summaryUncoordinated.arm).toBe("deep-swe-baseline");
		expect(summaryUncoordinated.recordedArm).toBe("deep-swe-baseline");

		const labeledRun = fakeRun("deep-swe-baseline", {
			label: "Custom Baseline Label",
			config: { experiment: "deep-swe", arm: "baseline" },
		});
		const summaryLabeled = summarizeArm(labeledRun, []);
		expect(summaryLabeled.arm).toBe("Custom Baseline Label");
		// A label renames the row; it never renames the coordinates the run recorded, which is what
		// the dashboard shows beside the label and offers as the label field's placeholder.
		expect(summaryLabeled.recordedArm).toBe("baseline");
	});

	it("canonicalArmOf preserves multi-hyphen arms and strips only re-run suffixes", () => {
		const runFix = fakeRun("deep-swe-treatment-v2-fix", {
			config: { experiment: "deep-swe", arm: "treatment-v2-fix" },
		});
		expect(canonicalArmOf(runFix)).toBe("treatment-v2");

		const runBackfill = fakeRun("deep-swe-treatment-v2-backfill2", {
			config: { experiment: "deep-swe", arm: "treatment-v2-backfill2" },
		});
		expect(canonicalArmOf(runBackfill)).toBe("treatment-v2");

		const uncoordinatedFix = fakeRun("deep-swe-baseline-fix", { config: {} });
		expect(canonicalArmOf(uncoordinatedFix)).toBe("deep-swe-baseline");
	});

	it("buildExperiments and experimentDetail group multi-hyphen runs into the same experiment", () => {
		const dir = makeStoreDir();
		const store = new RunStore(dir);

		store.registerLaunch({
			jobName: "deep-swe-baseline",
			dataset: "bench-dataset",
			agent: "veyyon",
			models: ["claude-opus"],
			pid: 10001,
			config: { experiment: "deep-swe", arm: "baseline" },
		});

		store.registerLaunch({
			jobName: "deep-swe-treatment-variant-1",
			dataset: "bench-dataset",
			agent: "veyyon",
			models: ["claude-opus"],
			pid: 10002,
			config: { experiment: "deep-swe", arm: "treatment-variant-1" },
		});

		const experiments = buildExperiments(store);
		const deepSweExp = experiments.find(e => e.id === "deep-swe");
		expect(deepSweExp).toBeDefined();
		expect(deepSweExp?.arms).toBe(2);

		const detail = experimentDetail(store, "deep-swe");
		expect(detail).not.toBeNull();
		expect(detail?.id).toBe("deep-swe");
		const armNames = detail?.arms.map(a => a.arm).sort();
		expect(armNames).toEqual(["baseline", "treatment-variant-1"]);

		store.close();
	});

	it("reports the canonical arm a re-run merged into, not the re-run's own suffix", () => {
		const dir = makeStoreDir();
		const store = new RunStore(dir);

		// Only the re-run exists: its own arm is `treatment-v2-fix`, and the arm it belongs to is
		// `treatment-v2`. A reader that showed the run's own arm would name a row nobody launched.
		store.registerLaunch({
			jobName: "deep-swe-treatment-v2-fix",
			dataset: "bench-dataset",
			agent: "veyyon",
			models: ["claude-opus"],
			pid: 10003,
			config: { experiment: "deep-swe", arm: "treatment-v2-fix" },
		});

		const detail = experimentDetail(store, "deep-swe");
		expect(detail?.arms.map(a => a.recordedArm)).toEqual(["treatment-v2"]);
		expect(Object.keys(detail?.matrix ?? {})).toEqual(["treatment-v2"]);

		store.close();
	});
});
