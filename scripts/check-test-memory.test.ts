/**
 * The arithmetic behind the test-memory gate, pinned on known answers.
 *
 * WHY THIS SUITE EXISTS. `check-test-memory.ts` turns a stream of RSS readings
 * into two numbers that decide whether the suite is healthy, and both are easy
 * to get quietly wrong. A slope computed from the endpoints instead of the trend
 * reports a scary number for a run where one file allocated and freed. A peak
 * taken across all processes instead of per process reports four workers' memory
 * as one worker's. A parser that silently drops malformed lines reports a small
 * slope from two readings and passes.
 *
 * The gate's own measurement is not tested here. Running 60 test files twice
 * takes minutes and its numbers move with the machine; what must never move is
 * the arithmetic, so that is what this file pins. The measured ceilings live in
 * `CEILINGS` with the date and the run they came from.
 */
import { describe, expect, it } from "bun:test";
import {
	CEILINGS,
	parseRssReadings,
	peakMb,
	readingsForBusiestProcess,
	sampleTestFiles,
	slopeMbPerFile,
} from "./check-test-memory";

const MB = 1024 * 1024;

/** `n` readings from one process, `startMb` growing by `stepMb` each file. */
function series(pid: number, startMb: number, stepMb: number, n: number): string {
	return Array.from({ length: n }, (_, i) => `RSS_AFTER_FILE ${pid} ${(startMb + i * stepMb) * MB}`).join("\n");
}

describe("parsing the preload's readings", () => {
	/** The ordinary case, in the exact format the preload writes. */
	it("reads pid and byte count from every reading", () => {
		const readings = parseRssReadings("RSS_AFTER_FILE 1234 104857600\nRSS_AFTER_FILE 1234 209715200\n");
		expect(readings).toEqual([
			{ pid: 1234, rssBytes: 104857600 },
			{ pid: 1234, rssBytes: 209715200 },
		]);
	});

	/**
	 * A suite's own stderr must not become a reading.
	 *
	 * Tests log, and a gate that fell over or miscounted because one printed a
	 * warning would be switched off within a week.
	 */
	it("ignores every other line on stderr", () => {
		const stderr = [
			"warn: something happened",
			"RSS_AFTER_FILE 7 1048576",
			"error: a test failed",
			"RSS_AFTER_FILEX 7 99",
			" RSS_AFTER_FILE 7 99",
			"RSS_AFTER_FILE 7 1048576 extra",
		].join("\n");
		expect(parseRssReadings(stderr)).toEqual([{ pid: 7, rssBytes: 1048576 }]);
	});

	/**
	 * A malformed reading is dropped, not read as zero.
	 *
	 * A zero would drag the slope down and let a regression through, which is the
	 * failure mode that matters: the gate reporting health it did not measure.
	 */
	it("drops readings that are not a positive number of bytes", () => {
		const stderr = ["RSS_AFTER_FILE 7 0", "RSS_AFTER_FILE 7 -5", "RSS_AFTER_FILE 7 abc", "RSS_AFTER_FILE x 100"].join(
			"\n",
		);
		expect(parseRssReadings(stderr)).toEqual([]);
	});

	/** Nothing at all is nothing, which the caller turns into a loud error. */
	it("returns no readings for output that has none", () => {
		expect(parseRssReadings("bun test v1.3.14\n 40 pass\n")).toEqual([]);
	});
});

describe("the slope", () => {
	/** A perfectly linear series reports exactly its step. */
	it("is the per-file step of a linear series", () => {
		expect(slopeMbPerFile(parseRssReadings(series(1, 200, 50, 8)))).toBeCloseTo(50, 6);
	});

	/** The real measurement that set the ceiling, to one decimal place. */
	it("reproduces the 2026-07-26 session/agent-session series", () => {
		const measured = [232, 286, 343, 388, 427, 475, 522, 564];
		const readings = parseRssReadings(measured.map(mb => `RSS_AFTER_FILE 9 ${mb * MB}`).join("\n"));
		expect(slopeMbPerFile(readings)).toBeCloseTo(46.9, 1);
	});

	/** A flat series is flat, which is what a cached graph looks like. */
	it("is zero when nothing grows", () => {
		expect(slopeMbPerFile(parseRssReadings(series(3, 170, 0, 8)))).toBe(0);
	});

	/**
	 * One file that allocates and frees does not become the trend.
	 *
	 * THE BUG THIS LOCKS OUT. `(last - first) / n` over a flat series with a spike
	 * in the middle reports zero, and over a flat series that ENDS on a spike
	 * reports the whole spike as a per-file cost. Least squares reports the trend,
	 * which is the quantity that multiplies by 1,887 files.
	 */
	it("is near zero for a flat series with one spike in it", () => {
		const spiked = [200, 200, 900, 200, 200, 200];
		const readings = parseRssReadings(spiked.map(mb => `RSS_AFTER_FILE 4 ${mb * MB}`).join("\n"));
		expect(Math.abs(slopeMbPerFile(readings))).toBeLessThan(25);

		// The endpoint formula this replaced would call the same series flat only by
		// luck: move the spike to the end and it reports the whole 700 MB as trend.
		const trailing = [200, 200, 200, 200, 200, 900];
		const endpointSlope = (900 - 200) / (trailing.length - 1);
		expect(endpointSlope).toBeGreaterThan(100);
		expect(
			slopeMbPerFile(parseRssReadings(trailing.map(mb => `RSS_AFTER_FILE 4 ${mb * MB}`).join("\n"))),
		).toBeLessThan(endpointSlope);
	});

	/** A single reading cannot describe a trend, so it reports none. */
	it("is zero for fewer than two readings", () => {
		expect(slopeMbPerFile(parseRssReadings("RSS_AFTER_FILE 4 104857600"))).toBe(0);
		expect(slopeMbPerFile([])).toBe(0);
	});
});

describe("the peak", () => {
	/** The largest single reading, in MB. */
	it("is the largest reading", () => {
		expect(peakMb(parseRssReadings(series(1, 100, 25, 5)))).toBeCloseTo(200, 6);
	});

	/**
	 * Workers are not summed.
	 *
	 * Under default parallelism four workers report interleaved, and adding them
	 * would report the machine's total as one worker's retention, which is the
	 * number the ceiling is about.
	 */
	it("does not add up what different processes hold", () => {
		const stderr = [series(11, 300, 0, 3), series(12, 320, 0, 3), series(13, 310, 0, 3)].join("\n");
		expect(peakMb(parseRssReadings(stderr))).toBeCloseTo(320, 6);
	});
});

describe("picking one worker's series out of an interleaved run", () => {
	/**
	 * The busiest worker is the one that ran the most files.
	 *
	 * Its series is the only one long enough to have a trend, and a slope taken
	 * across interleaved pids describes no process at all.
	 */
	it("returns the longest series and keeps its order", () => {
		const stderr = [
			`RSS_AFTER_FILE 11 ${100 * MB}`,
			`RSS_AFTER_FILE 12 ${500 * MB}`,
			`RSS_AFTER_FILE 11 ${150 * MB}`,
			`RSS_AFTER_FILE 11 ${200 * MB}`,
		].join("\n");
		expect(readingsForBusiestProcess(parseRssReadings(stderr))).toEqual([
			{ pid: 11, rssBytes: 100 * MB },
			{ pid: 11, rssBytes: 150 * MB },
			{ pid: 11, rssBytes: 200 * MB },
		]);
	});

	/** With one process the busiest series is the whole run. */
	it("returns everything when one process ran everything", () => {
		expect(readingsForBusiestProcess(parseRssReadings(series(5, 100, 10, 4)))).toHaveLength(4);
	});
});

describe("the sample", () => {
	/**
	 * The same N files every run.
	 *
	 * A gate that sampled a different N each time would move its own numbers, and
	 * the first thing anyone would do with a moving ceiling is raise it.
	 */
	it("is sorted, capped, and stable across calls", () => {
		const rootDir = new URL("..", import.meta.url).pathname;
		const first = sampleTestFiles(rootDir, "packages/coding-agent/test", 12);
		const second = sampleTestFiles(rootDir, "packages/coding-agent/test", 12);

		expect(first).toHaveLength(12);
		expect(first).toEqual(second);
		expect(first).toEqual([...first].sort());
		expect(first.every(f => f.endsWith(".test.ts"))).toBe(true);
		expect(first[0]).toStartWith("packages/coding-agent/test/");
	});

	/** A larger sample starts with the smaller one, so the numbers stay comparable. */
	it("grows by extending, never by reshuffling", () => {
		const rootDir = new URL("..", import.meta.url).pathname;
		const small = sampleTestFiles(rootDir, "packages/coding-agent/test", 5);
		const large = sampleTestFiles(rootDir, "packages/coding-agent/test", 20);
		expect(large.slice(0, 5)).toEqual(small);
	});
});

describe("the ceilings", () => {
	/**
	 * Headroom over what was measured, and not so much that the OOM fits under it.
	 *
	 * The measured slope was 75.8 MB/file and the suite has 1,887 files, so the
	 * ceiling has to sit above the measurement and below the slope that kills the
	 * run. Pinning both ends stops the ceiling from being raised into a no-op the
	 * next time it fails.
	 */
	it("sit above the 2026-07-26 measurements and below the kill", () => {
		expect(CEILINGS.serialSlopeMbPerFile).toBeGreaterThan(75.8);
		expect((CEILINGS.serialSlopeMbPerFile * 1887) / 1024).toBeLessThan(200);
		expect(CEILINGS.workerPeakMb).toBeGreaterThan(0.76 * 1024);
		expect(CEILINGS.workerPeakMb).toBeLessThan(4096);
	});
});
