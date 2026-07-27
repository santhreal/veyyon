#!/usr/bin/env bun
// Memory gate for the test suite: what one more test file costs, and what one
// worker holds.
//
// Why this gate exists. A full `bun test --parallel=1 packages/coding-agent/test`
// is SIGKILLed by the kernel at about 13.4 GB, so nobody can run the suite
// locally and CI becomes the only evidence it passes. That is exactly the class
// of failure that needs a local loop to fix, and the loop is the thing that
// broke.
//
// What was measured on 2026-07-26, because the number this gate pins is
// meaningless without it. Bun's two run modes behave completely differently.
// Under the DEFAULT parallelism files run in worker processes that get recycled,
// modules are cached across the files a worker runs, and what a worker holds is
// the UNION of what those files reach: bounded. Under `--parallel=1` every file
// runs in ONE process, workspace source is re-instantiated for every file and
// never freed, and the run costs the SUM. The same 60 files peak at 0.76 GB by
// default and 4.62 GB with the flag, a slope of 75.8 MB per file, and 1,887
// files at that slope is the kill.
//
// So there are two numbers and one ceiling is no use for the other:
//
//   SLOPE   -- MB the serial run gains per additional test file. This is what
//              turns into an OOM at suite scale, and it is what trimming a
//              file's import graph reduces.
//   WORKER  -- the most any single worker process holds under default
//              parallelism. This is what a leak shows up in: retained sessions,
//              open databases, temp workspaces, module-level caches that grow.
//
// The instrument is `packages/utils/test/helpers/rss-after-each-file.ts`, a
// preload whose `afterAll` bun runs once per test FILE, so a run emits one RSS
// reading per file in the order the files ran. Readings carry the pid because
// under default parallelism several workers interleave.
//
// Usage:
//   bun run scripts/check-test-memory.ts            # gate, default sample
//   bun run scripts/check-test-memory.ts --report   # print the numbers, assert nothing
//   bun run scripts/check-test-memory.ts --files=120 --dir=packages/coding-agent/test

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Written by the preload, one per test file. `PREFIX pid rssBytes`. */
const RSS_REPORT_PREFIX = "RSS_AFTER_FILE";

const BYTES_PER_MB = 1024 * 1024;

/**
 * Ceilings, each with the measurement it was set from and the headroom.
 *
 * Both are deliberately loose enough to survive machine variance and tight
 * enough that a regression of the kind that caused the OOM cannot hide under
 * them. Raising either is a decision about the suite, not a formality: say in
 * `BACKLOG.md` what changed and why the new number is acceptable.
 */
export const CEILINGS = {
	/** Measured 75.8 MB/file over the first 60 files on 2026-07-26. */
	serialSlopeMbPerFile: 95,
	/** Measured 0.76 GB across the whole tree for the same 60 files. */
	workerPeakMb: 1400,
} as const;

/** How many test files the gate samples when nothing says otherwise. */
const DEFAULT_SAMPLE = 60;

export interface RssReading {
	pid: number;
	rssBytes: number;
}

/**
 * Parse the preload's readings out of a run's stderr.
 *
 * Anything else on stderr is ignored rather than rejected: a suite is free to
 * log, and a gate that fell over because a test printed a warning would be
 * switched off within a week.
 */
export function parseRssReadings(stderr: string): RssReading[] {
	const readings: RssReading[] = [];
	for (const line of stderr.split("\n")) {
		if (!line.startsWith(`${RSS_REPORT_PREFIX} `)) continue;
		// Exactly three fields, because a line that merely STARTS like a reading is
		// not one. Reading `PREFIX pid rss something-else` would let a suite that
		// echoes the preload's output feed the gate its own numbers.
		const fields = line.split(" ");
		if (fields.length !== 3) continue;
		const [, pidText, rssText] = fields;
		const pid = Number(pidText);
		const rssBytes = Number(rssText);
		if (!Number.isInteger(pid) || !Number.isFinite(rssBytes) || rssBytes <= 0) continue;
		readings.push({ pid, rssBytes });
	}
	return readings;
}

/**
 * MB gained per additional file, by least squares over one process's series.
 *
 * Least squares rather than (last - first) / n because a single file that
 * allocates a lot and frees it would swing the endpoints while saying nothing
 * about the trend, and the trend is what multiplies by 1,887.
 */
export function slopeMbPerFile(readings: RssReading[]): number {
	if (readings.length < 2) return 0;
	const n = readings.length;
	const meanX = (n - 1) / 2;
	const meanY = readings.reduce((sum, r) => sum + r.rssBytes, 0) / n;
	let covariance = 0;
	let variance = 0;
	for (const [index, reading] of readings.entries()) {
		covariance += (index - meanX) * (reading.rssBytes - meanY);
		variance += (index - meanX) ** 2;
	}
	if (variance === 0) return 0;
	return covariance / variance / BYTES_PER_MB;
}

/** The largest reading any single process reported, in MB. */
export function peakMb(readings: RssReading[]): number {
	return readings.reduce((max, r) => Math.max(max, r.rssBytes), 0) / BYTES_PER_MB;
}

/** Readings for one pid, in the order they were reported. */
export function readingsForBusiestProcess(readings: RssReading[]): RssReading[] {
	const byPid = new Map<number, RssReading[]>();
	for (const reading of readings) {
		const series = byPid.get(reading.pid) ?? [];
		series.push(reading);
		byPid.set(reading.pid, series);
	}
	let busiest: RssReading[] = [];
	for (const series of byPid.values()) {
		if (series.length > busiest.length) busiest = series;
	}
	return busiest;
}

/** Test files under `dir`, sorted, so a sample of N is the same N every run. */
export function sampleTestFiles(rootDir: string, dir: string, limit: number): string[] {
	const found: string[] = [];
	const walk = (current: string): void => {
		for (const entry of fs
			.readdirSync(current, { withFileTypes: true })
			.sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
				walk(full);
			} else if (entry.name.endsWith(".test.ts")) {
				found.push(path.relative(rootDir, full));
			}
		}
	};
	walk(path.join(rootDir, dir));
	found.sort();
	return found.slice(0, limit);
}

export interface Measurement {
	mode: "serial" | "workers";
	readings: RssReading[];
	slope: number;
	peak: number;
	processes: number;
}

/** Run the sample under one mode and report what the preload saw. */
export function measure(rootDir: string, files: string[], mode: "serial" | "workers"): Measurement {
	const preload = path.join(rootDir, "packages/utils/test/helpers/rss-after-each-file.ts");
	const args = ["test", ...(mode === "serial" ? ["--parallel=1"] : []), "--preload", preload, ...files];
	const run = spawnSync("bun", args, { cwd: rootDir, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
	const readings = parseRssReadings(run.stderr ?? "");
	if (readings.length === 0) {
		// Loudly, not as a zero: a run that reported nothing has measured nothing,
		// and a gate that treats "no data" as "under the ceiling" is worse than no
		// gate at all.
		throw new Error(
			`no ${RSS_REPORT_PREFIX} readings from the ${mode} run of ${files.length} files. ` +
				`bun exited ${run.status}. Check that the preload still registers its afterAll.`,
		);
	}
	const series = mode === "serial" ? readings : readingsForBusiestProcess(readings);
	return {
		mode,
		readings,
		slope: slopeMbPerFile(series),
		peak: peakMb(readings),
		processes: new Set(readings.map(r => r.pid)).size,
	};
}

if (import.meta.main) {
	const rootDir = path.resolve(import.meta.dir, "..");
	const argOf = (name: string): string | undefined =>
		process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
	const reportOnly = process.argv.includes("--report");
	const dir = argOf("dir") ?? "packages/coding-agent/test";
	const limit = Number(argOf("files") ?? DEFAULT_SAMPLE);
	const files = sampleTestFiles(rootDir, dir, limit);
	if (files.length < 2) {
		console.error(`only ${files.length} test file(s) under ${dir}; nothing to measure`);
		process.exit(1);
	}

	const serial = measure(rootDir, files, "serial");
	const workers = measure(rootDir, files, "workers");
	console.log(
		`sampled ${files.length} files under ${dir}\n` +
			`  serial  (--parallel=1): ${serial.slope.toFixed(1)} MB/file, peak ${serial.peak.toFixed(0)} MB, ` +
			`${serial.readings.length} readings\n` +
			`  workers (default):      ${workers.slope.toFixed(1)} MB/file, peak ${workers.peak.toFixed(0)} MB, ` +
			`${workers.processes} processes`,
	);
	if (reportOnly) process.exit(0);

	const failures: string[] = [];
	if (serial.slope > CEILINGS.serialSlopeMbPerFile) {
		failures.push(
			`serial slope ${serial.slope.toFixed(1)} MB/file exceeds ${CEILINGS.serialSlopeMbPerFile}. ` +
				`At this slope the full suite needs ${((serial.slope * 1887) / 1024).toFixed(0)} GB. ` +
				`Trim what test files import, leaf first.`,
		);
	}
	if (workers.peak > CEILINGS.workerPeakMb) {
		failures.push(
			`worker peak ${workers.peak.toFixed(0)} MB exceeds ${CEILINGS.workerPeakMb}. ` +
				`A worker holds the union of what its files reach plus whatever they retain; ` +
				`look for sessions, databases, temp workspaces and caches that are never released.`,
		);
	}
	if (failures.length > 0) {
		console.error(`\n${failures.length} test-memory ceiling(s) exceeded:`);
		for (const failure of failures) console.error(`  ${failure}`);
		process.exit(1);
	}
}
