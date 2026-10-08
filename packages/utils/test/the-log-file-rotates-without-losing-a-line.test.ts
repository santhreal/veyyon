/**
 * The profile log file: every line a process writes is found exactly once, whole, in the day's file
 * or one of its generations, until the retention limit deletes the oldest.
 *
 * WHY: the file is shared by every veyyon process of a profile and rotated by whichever of them
 * sees it full. A rotation that renames over a generation another writer just created, a writer
 * that keeps appending to a moved file past the point it is compressed, or a compression that
 * publishes before the copy finishes each loses lines in silence: nothing reads the log until
 * something has gone wrong. The multi-process test drives real concurrent writers on the real
 * clock, because the compression bound ({@link SETTLED_MS}) is a statement about wall time.
 *
 * The single-process tests pass a synthetic `now` to reach each maintenance branch (rotation,
 * day change, retention, compression age, stale files, a moved or removed file, a failing
 * destination) without sleeping.
 *
 * NOT COVERED: a destination on a filesystem without hard links (`link` claims a generation), and
 * a crash between claiming a generation and unlinking the live name, which leaves the live name
 * and the generation sharing one inode until the next rotation.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import * as zlib from "node:zlib";
import { getLogPath, getLogsDir } from "@veyyon/utils/dirs";
import { CHECK_INTERVAL_MS, logFileName, RotatingLogFile, SETTLED_MS } from "@veyyon/utils/log-file";
import { TempDir } from "@veyyon/utils/temp";

const LOG_NAME = /^veyyon\.\d{4}-\d{2}-\d{2}\.log(?:\.(\d+))?(\.gz)?$/;

const temps: TempDir[] = [];
afterEach(() => {
	for (const temp of temps.splice(0)) temp.removeSync();
});

function tempDir(): string {
	const temp = TempDir.createSync("@log-file-");
	temps.push(temp);
	return temp.path();
}

function noErrors(): (error: Error) => void {
	return error => {
		throw error;
	};
}

/**
 * Every log file in `dir`, keyed by its uncompressed name, with its lines.
 *
 * A generation whose compressed copy was published but whose source is not yet deleted appears
 * twice with the same bytes; the source is read and the copy skipped.
 */
function readLogFiles(dir: string): Map<string, string[]> {
	const names = fs.readdirSync(dir);
	const out = new Map<string, string[]>();
	for (const name of names) {
		if (!LOG_NAME.test(name)) continue;
		const compressed = name.endsWith(".gz");
		const key = compressed ? name.slice(0, -3) : name;
		if (compressed && names.includes(key)) continue;
		const bytes = fs.readFileSync(path.join(dir, name));
		const text = compressed ? zlib.gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
		out.set(
			key,
			text.split("\n").filter(line => line.length > 0),
		);
	}
	return out;
}

/**
 * Waits until compression in `dir` is done: no temporary, no source beside its copy, and the same
 * listing across 100 ms. A compression starts its temporary asynchronously, so an empty moment right
 * after the write that started it is not the end of it.
 */
async function settled(dir: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	let previous = "";
	let stable = 0;
	while (Date.now() < deadline) {
		const names = fs.readdirSync(dir).sort();
		const busy = names.some(n => n.endsWith(".tmp") || (n.endsWith(".gz") && names.includes(n.slice(0, -3))));
		const listing = names.join("\n");
		stable = !busy && listing === previous ? stable + 1 : 0;
		previous = listing;
		if (stable >= 5) return;
		await sleep(20);
	}
	throw new Error(`compression in ${dir} did not finish: ${fs.readdirSync(dir).join(", ")}`);
}

function generationOf(name: string): number {
	return Number(LOG_NAME.exec(name)?.[1] ?? 0);
}

const FULL_LINE = JSON.stringify({ i: 0, pad: "y".repeat(80) });
const OTHER_LINE = JSON.stringify({ other: true });

/**
 * Runs `write` with `interleave` executed right after the rotation lists the directory: another
 * writer acting between the scan and the claim, which leaves the scan stale. The race the
 * multi-process test reaches by chance, reached every time.
 */
function withWriterAfterScan(interleave: () => void, write: () => void): void {
	const realReaddir = fs.readdirSync;
	const spy = spyOn(fs, "readdirSync").mockImplementation(((...args: Parameters<typeof fs.readdirSync>) => {
		spy.mockRestore();
		const listing = realReaddir(...args);
		interleave();
		return listing;
	}) as typeof fs.readdirSync);
	try {
		write();
	} finally {
		spy.mockRestore();
	}
}

describe("concurrent writers", () => {
	it("each line lands whole and exactly once while the file rotates under them", async () => {
		const dir = tempDir();
		const writers = 4;
		const linesPerWriter = 3_000;
		const moduleUrl = pathToFileURL(path.join(import.meta.dirname, "..", "src", "log-file.ts")).href;
		// About 2.5 s of steady writing per process: every writer checks the path about twice, and
		// each check finds the file past `maxBytes`, so the directory rotates several times while
		// the others are still appending to what they opened.
		const script = `
			const { setTimeout: sleep } = await import("node:timers/promises");
			const { RotatingLogFile } = await import(${JSON.stringify(moduleUrl)});
			const log = new RotatingLogFile(${JSON.stringify(dir)}, {
				maxBytes: 32 * 1024,
				keep: 1000,
				onError: error => { process.stderr.write(error.stack + "\\n"); process.exitCode = 1; },
			});
			const pad = "x".repeat(96);
			for (let seq = 0; seq < ${linesPerWriter}; seq++) {
				log.write(JSON.stringify({ pid: process.pid, seq, pad }) + "\\n", new Date());
				if (seq % 12 === 11) await sleep(10);
			}
			log.close();
		`;
		const exits = await Promise.all(
			Array.from({ length: writers }, () => {
				const { promise, resolve } = Promise.withResolvers<{ pid: number; code: number | null; stderr: string }>();
				const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "pipe"] });
				let stderr = "";
				child.stderr.on("data", chunk => {
					stderr += String(chunk);
				});
				child.on("close", code => resolve({ pid: child.pid ?? -1, code, stderr }));
				return promise;
			}),
		);
		for (const exit of exits) expect({ code: exit.code, stderr: exit.stderr }).toEqual({ code: 0, stderr: "" });

		const files = readLogFiles(dir);
		// Rotation happened, so the assertion below is about lines crossing generations.
		expect(files.size).toBeGreaterThanOrEqual(3);

		const seen = new Map<number, number[]>();
		for (const lines of files.values()) {
			for (const line of lines) {
				const entry = JSON.parse(line) as { pid: number; seq: number };
				let seqs = seen.get(entry.pid);
				if (!seqs) {
					seqs = [];
					seen.set(entry.pid, seqs);
				}
				seqs.push(entry.seq);
			}
		}
		const expected = Array.from({ length: linesPerWriter }, (_, i) => i);
		expect([...seen.keys()].sort()).toEqual(exits.map(exit => exit.pid).sort());
		for (const seqs of seen.values()) expect(seqs.sort((a, b) => a - b)).toEqual(expected);
	}, 30_000);
});

describe("rotation", () => {
	it("moves a full live file to the next generation and keeps the newest lines at the day's path", async () => {
		const dir = tempDir();
		const log = new RotatingLogFile(dir, { maxBytes: 64, keep: 100, onError: noErrors() });
		const start = Date.now();
		for (let i = 0; i < 6; i++) {
			log.write(`${JSON.stringify({ i, pad: "y".repeat(80) })}\n`, new Date(start + i * CHECK_INTERVAL_MS));
		}
		log.close();
		await settled(dir);

		const live = logFileName(new Date(start));
		const files = readLogFiles(dir);
		const order = [...files.keys()].sort((a, b) => (generationOf(a) || Infinity) - (generationOf(b) || Infinity));
		// Oldest generation first, the live file last: one line each, in write order.
		expect(order.map(name => files.get(name)?.map(line => (JSON.parse(line) as { i: number }).i))).toEqual([
			[0],
			[1],
			[2],
			[3],
			[4],
			[5],
		]);
		expect(order.at(-1)).toBe(live);
		expect(order.slice(0, -1)).toEqual([1, 2, 3, 4, 5].map(n => `${live}.${n}`));
	});

	it("does not rotate a live file below the size limit", () => {
		const dir = tempDir();
		const log = new RotatingLogFile(dir, { maxBytes: 1024, keep: 100, onError: noErrors() });
		const start = Date.now();
		for (let i = 0; i < 5; i++) log.write(`line ${i}\n`, new Date(start + i * CHECK_INTERVAL_MS));
		log.close();
		expect(fs.readdirSync(dir)).toEqual([logFileName(new Date(start))]);
	});

	it("checks the size at most once per interval", () => {
		const dir = tempDir();
		const log = new RotatingLogFile(dir, { maxBytes: 16, keep: 100, onError: noErrors() });
		const start = Date.now();
		// Twenty lines inside one interval: the first opens the file, the rest append past the limit.
		for (let i = 0; i < 20; i++) log.write(`line ${i}\n`, new Date(start + i));
		log.close();
		expect(fs.readdirSync(dir)).toEqual([logFileName(new Date(start))]);
		expect(readLogFiles(dir).get(logFileName(new Date(start)))).toHaveLength(20);
	});

	it("takes the next free generation when another writer claims one after the scan", async () => {
		const dir = tempDir();
		const log = new RotatingLogFile(dir, { maxBytes: 64, keep: 100, onError: noErrors() });
		const start = Date.now();
		const live = logFileName(new Date(start));
		log.write(`${FULL_LINE}\n`, new Date(start));
		// The other writer rotates its own full file to generation 1, which this writer's scan missed.
		withWriterAfterScan(
			() => fs.writeFileSync(path.join(dir, `${live}.1`), `${OTHER_LINE}\n`),
			() => log.write(`${JSON.stringify({ i: 1 })}\n`, new Date(start + CHECK_INTERVAL_MS)),
		);
		log.close();
		await settled(dir);

		expect(Object.fromEntries(readLogFiles(dir))).toEqual({
			[`${live}.1`]: [OTHER_LINE],
			[`${live}.2`]: [FULL_LINE],
			[live]: [JSON.stringify({ i: 1 })],
		});
	});

	it("leaves a fresh live file in place when another writer already rotated the full one", async () => {
		const dir = tempDir();
		const log = new RotatingLogFile(dir, { maxBytes: 64, keep: 100, onError: noErrors() });
		const start = Date.now();
		const live = logFileName(new Date(start));
		log.write(`${FULL_LINE}\n`, new Date(start));
		// The other writer moves the same full file to generation 1 and starts a fresh live file, so
		// this writer's claim links the fresh file, not the one it found full.
		withWriterAfterScan(
			() => {
				fs.renameSync(path.join(dir, live), path.join(dir, `${live}.1`));
				fs.writeFileSync(path.join(dir, live), `${OTHER_LINE}\n`);
			},
			() => log.write(`${JSON.stringify({ i: 1 })}\n`, new Date(start + CHECK_INTERVAL_MS)),
		);
		log.close();
		await settled(dir);

		expect(Object.fromEntries(readLogFiles(dir))).toEqual({
			[`${live}.1`]: [FULL_LINE],
			[live]: [OTHER_LINE, JSON.stringify({ i: 1 })],
		});
	});
});

describe("the day's file", () => {
	it("opens the next day's file at local midnight and leaves the previous day's file in place", () => {
		const dir = tempDir();
		const log = new RotatingLogFile(dir, { maxBytes: 1024 * 1024, keep: 100, onError: noErrors() });
		const evening = new Date(2026, 2, 14, 23, 59, 59, 500);
		const morning = new Date(2026, 2, 15, 0, 0, 1, 0);
		log.write("before midnight\n", evening);
		log.write("after midnight\n", morning);
		log.close();
		const files = readLogFiles(dir);
		expect(files.get("veyyon.2026-03-14.log")).toEqual(["before midnight"]);
		expect(files.get("veyyon.2026-03-15.log")).toEqual(["after midnight"]);
		expect(files.size).toBe(2);
	});

	/**
	 * The name is the LOCAL calendar day, and every reader names the day the writer does. A reader
	 * that took the UTC date pointed at the wrong day's file for part of every day in any zone
	 * other than UTC.
	 */
	it("is named by the local date for the writer and for getLogPath alike", () => {
		const probe = `
			const { logFileName } = await import(${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "..", "src", "log-file.ts")).href)});
			const { getLogPath } = await import(${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "..", "src", "dirs.ts")).href)});
			const early = new Date(2026, 0, 1, 5, 0, 0);
			process.stdout.write(JSON.stringify({ utc: early.toISOString(), name: logFileName(early), path: getLogPath(early) }));
		`;
		const run = spawnSync(process.execPath, ["-e", probe], {
			env: { ...process.env, TZ: "Pacific/Kiritimati" },
			encoding: "utf8",
		});
		expect(run.stderr).toBe("");
		const out = JSON.parse(run.stdout) as { utc: string; name: string; path: string };
		// UTC+14: five in the morning of New Year's Day is still the previous year in UTC.
		expect(out.utc.slice(0, 10)).toBe("2025-12-31");
		expect(out.name).toBe("veyyon.2026-01-01.log");
		expect(path.basename(out.path)).toBe("veyyon.2026-01-01.log");
	});

	it("resolves to the same path the logs directory reports", () => {
		const now = new Date();
		expect(getLogPath(now)).toBe(path.join(getLogsDir(), logFileName(now)));
	});
});

describe("retention", () => {
	it("keeps only the newest files, the live file included", async () => {
		const dir = tempDir();
		const log = new RotatingLogFile(dir, { maxBytes: 8, keep: 3, onError: noErrors() });
		const start = Date.now();
		for (let i = 0; i < 10; i++) log.write(`line number ${i}\n`, new Date(start + i * CHECK_INTERVAL_MS));
		log.close();
		await settled(dir);
		const files = readLogFiles(dir);
		expect(files.size).toBe(3);
		// The two newest generations and the live file survive, holding the three newest lines.
		expect([...files.values()].flat().sort()).toEqual(["line number 7", "line number 8", "line number 9"]);
	});

	it("never deletes the live file, whatever its age", () => {
		const dir = tempDir();
		const now = new Date();
		const live = path.join(dir, logFileName(now));
		fs.writeFileSync(live, "old live line\n");
		const ancient = new Date(now.getTime() - 86_400_000);
		fs.utimesSync(live, ancient, ancient);
		for (let n = 1; n <= 3; n++) fs.writeFileSync(`${live}.${n}`, `generation ${n}\n`);
		const log = new RotatingLogFile(dir, { keep: 1, onError: noErrors() });
		log.write("new line\n", now);
		log.close();
		expect(fs.readdirSync(dir)).toEqual([path.basename(live)]);
		expect(fs.readFileSync(live, "utf8")).toBe("old live line\nnew line\n");
	});
});

describe("compression", () => {
	function generationAged(dir: string, now: Date, ageMs: number): string {
		const generation = path.join(dir, `${logFileName(now)}.1`);
		fs.writeFileSync(generation, "a settled line\n");
		const mtime = new Date(now.getTime() - ageMs);
		fs.utimesSync(generation, mtime, mtime);
		return generation;
	}

	it("gzips a generation nobody has written for the settle time, and deletes the source", async () => {
		const dir = tempDir();
		const now = new Date();
		const generation = generationAged(dir, now, SETTLED_MS + 100);
		const log = new RotatingLogFile(dir, { onError: noErrors() });
		log.write("live\n", now);
		log.close();
		await settled(dir);
		expect(fs.existsSync(generation)).toBe(false);
		expect(zlib.gunzipSync(fs.readFileSync(`${generation}.gz`)).toString("utf8")).toBe("a settled line\n");
	});

	it("leaves a generation younger than the settle time uncompressed", async () => {
		const dir = tempDir();
		const now = new Date();
		const generation = generationAged(dir, now, SETTLED_MS - 100);
		const log = new RotatingLogFile(dir, { onError: noErrors() });
		log.write("live\n", now);
		log.close();
		await sleep(50);
		expect(fs.readFileSync(generation, "utf8")).toBe("a settled line\n");
		expect(fs.existsSync(`${generation}.gz`)).toBe(false);
	});

	it("never compresses the live file", async () => {
		const dir = tempDir();
		const now = new Date();
		const live = path.join(dir, logFileName(now));
		fs.writeFileSync(live, "first\n");
		const old = new Date(now.getTime() - 10 * SETTLED_MS);
		fs.utimesSync(live, old, old);
		const log = new RotatingLogFile(dir, { onError: noErrors() });
		log.write("second\n", now);
		log.close();
		await sleep(50);
		expect(fs.readdirSync(dir)).toEqual([path.basename(live)]);
	});
});

describe("leftovers in the directory", () => {
	it("deletes the audit files the previous log writer kept, and nothing else that is not a log", () => {
		const dir = tempDir();
		const audit = `.${"0123456789abcdef0123456789abcdef01234567"}-audit.json`;
		fs.writeFileSync(path.join(dir, audit), "{}");
		fs.writeFileSync(path.join(dir, "notes.txt"), "keep me");
		fs.writeFileSync(path.join(dir, ".abc-audit.json"), "not a 40-digit digest");
		const log = new RotatingLogFile(dir, { onError: noErrors() });
		const now = new Date();
		log.write("line\n", now);
		log.close();
		expect(fs.readdirSync(dir).sort()).toEqual([".abc-audit.json", logFileName(now), "notes.txt"].sort());
	});

	it("deletes a compression temporary a dead process abandoned, and keeps one still being written", () => {
		const dir = tempDir();
		const now = new Date();
		// The staging names atomicWriteFileWith gives `<generation>.gz`.
		const abandoned = path.join(dir, `.${logFileName(now)}.3.gz.4242.1.tmp`);
		const inFlight = path.join(dir, `.${logFileName(now)}.4.gz.4243.1.tmp`);
		fs.writeFileSync(abandoned, "partial");
		fs.writeFileSync(inFlight, "partial");
		const old = new Date(now.getTime() - 61_000);
		fs.utimesSync(abandoned, old, old);
		const log = new RotatingLogFile(dir, { onError: noErrors() });
		log.write("line\n", now);
		log.close();
		expect(fs.existsSync(abandoned)).toBe(false);
		expect(fs.existsSync(inFlight)).toBe(true);
	});
});

describe("a destination that changes under the writer", () => {
	it("follows the path to a new file when another process moved the live file away", () => {
		const dir = tempDir();
		const log = new RotatingLogFile(dir, { maxBytes: 1024 * 1024, onError: noErrors() });
		const start = Date.now();
		log.write("before the move\n", new Date(start));
		const live = path.join(dir, logFileName(new Date(start)));
		const moved = path.join(dir, "moved-away");
		fs.renameSync(live, moved);
		log.write("inside the same interval\n", new Date(start + 1));
		log.write("after the next check\n", new Date(start + CHECK_INTERVAL_MS));
		log.close();
		// A line inside the interval goes to the descriptor it already holds; the check reopens.
		expect(fs.readFileSync(moved, "utf8")).toBe("before the move\ninside the same interval\n");
		expect(fs.readFileSync(live, "utf8")).toBe("after the next check\n");
	});

	it("follows the path to the file another process created there after moving the old one", () => {
		const dir = tempDir();
		const log = new RotatingLogFile(dir, { maxBytes: 1024 * 1024, onError: noErrors() });
		const start = Date.now();
		log.write("before the move\n", new Date(start));
		const live = path.join(dir, logFileName(new Date(start)));
		const moved = path.join(dir, "moved-away");
		fs.renameSync(live, moved);
		// The path names a file again, a different one, well below the size limit.
		fs.writeFileSync(live, "another writer\n");
		log.write("after the next check\n", new Date(start + CHECK_INTERVAL_MS));
		log.close();
		expect(fs.readFileSync(moved, "utf8")).toBe("before the move\n");
		expect(fs.readFileSync(live, "utf8")).toBe("another writer\nafter the next check\n");
	});

	/** A full disk fails every `write(2)`; the report must not repeat once per dropped line. */
	it.skipIf(process.platform !== "linux")("reports a failed write once per interval", () => {
		const dir = tempDir();
		const now = new Date();
		fs.symlinkSync("/dev/full", path.join(dir, logFileName(now)));
		const errors: NodeJS.ErrnoException[] = [];
		const log = new RotatingLogFile(dir, { onError: error => errors.push(error) });
		for (let i = 0; i < 20; i++) log.write(`dropped ${i}\n`, new Date(now.getTime() + i));
		expect(errors.map(error => error.code)).toEqual(["ENOSPC"]);
		for (let i = 0; i < 20; i++) log.write(`dropped again ${i}\n`, new Date(now.getTime() + CHECK_INTERVAL_MS + i));
		log.close();
		expect(errors.map(error => error.code)).toEqual(["ENOSPC", "ENOSPC"]);
	});

	it("recreates a removed directory on the next check", () => {
		const parent = tempDir();
		const dir = path.join(parent, "logs");
		const log = new RotatingLogFile(dir, { onError: noErrors() });
		const start = Date.now();
		log.write("first\n", new Date(start));
		fs.rmSync(dir, { recursive: true, force: true });
		log.write("second\n", new Date(start + CHECK_INTERVAL_MS));
		log.close();
		expect(fs.readFileSync(path.join(dir, logFileName(new Date(start))), "utf8")).toBe("second\n");
	});

	it("reports an unusable destination once per interval and never throws to the writer", () => {
		const parent = tempDir();
		const dir = path.join(parent, "logs");
		const errors: Error[] = [];
		const log = new RotatingLogFile(dir, { onError: error => errors.push(error) });
		const start = Date.now();
		log.write("first\n", new Date(start));
		fs.rmSync(dir, { recursive: true, force: true });
		// A regular file where the directory was: every open under it fails.
		fs.writeFileSync(dir, "not a directory");
		for (let i = 0; i < 25; i++) log.write(`lost ${i}\n`, new Date(start + CHECK_INTERVAL_MS + i));
		expect(errors).toHaveLength(1);
		for (let i = 0; i < 3; i++) log.write(`lost again ${i}\n`, new Date(start + 2 * CHECK_INTERVAL_MS + i));
		expect(errors).toHaveLength(2);
		// The destination comes back: lines land again from the next check on.
		fs.rmSync(dir);
		log.write("back\n", new Date(start + 3 * CHECK_INTERVAL_MS));
		log.close();
		expect(errors).toHaveLength(2);
		expect(fs.readFileSync(path.join(dir, logFileName(new Date(start))), "utf8")).toBe("back\n");
	});

	it("rejects an unusable directory when the log file is created", () => {
		const parent = tempDir();
		const blocked = path.join(parent, "blocked");
		fs.writeFileSync(blocked, "not a directory");
		// The message names the directory, whether the filesystem or the test sandbox rejected it.
		const logs = path.join(blocked, "logs");
		expect(() => new RotatingLogFile(logs, { onError: noErrors() })).toThrow(logs);
		expect(fs.readFileSync(blocked, "utf8")).toBe("not a directory");
	});
});
