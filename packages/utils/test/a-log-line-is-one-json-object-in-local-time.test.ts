/**
 * The bytes of a log line: one JSON object per line, `timestamp` first in local time with its UTC
 * offset, then `level`, `pid` and `message`, then the caller's context fields. The file sink and
 * the console sink write the same bytes.
 *
 * WHY: `veyyon logs`, the debug report and a supervisor tailing a service all parse these lines,
 * and the format was produced by a logging library until the logger wrote it itself. A timestamp
 * without its offset cannot be ordered against another machine's, a context field that overwrites
 * `level` or `message` makes a line lie about itself, and a line split across two writes is two
 * unparseable halves.
 *
 * NOT COVERED: `Error` values in the context, which `logger-error-serialization.test.ts` owns.
 */
import { afterAll, beforeAll, describe, expect, it, setSystemTime, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as logger from "@veyyon/utils/logger";
import { TempDir } from "@veyyon/utils/temp";

let temp: TempDir;

beforeAll(() => {
	temp = TempDir.createSync("@log-line-");
});

afterAll(() => {
	logger.setTransports({ file: false, console: false });
	temp.removeSync();
});

/** Logs one line through both sinks and returns the file's and stdout's bytes for it. */
function emit(write: () => void): { file: string; stdout: string } {
	const dir = path.join(temp.path(), String(Math.random()).slice(2));
	logger.setTransports({ file: dir, console: true });
	const chunks: string[] = [];
	const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	});
	try {
		write();
	} finally {
		stdoutSpy.mockRestore();
		logger.setTransports({ file: false, console: false });
	}
	const file = fs
		.readdirSync(dir)
		.map(name => fs.readFileSync(path.join(dir, name), "utf8"))
		.join("");
	return { file, stdout: chunks.join("") };
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})([+-])(\d{2}):(\d{2})$/;

describe("a log line", () => {
	it("is one JSON object and one newline, the same bytes in the file and on stdout", () => {
		const out = emit(() => logger.info("line-format: plain", { count: 3, nested: { ok: true } }));
		expect(out.file).toBe(out.stdout);
		expect(out.file.endsWith("\n")).toBe(true);
		expect(out.file.indexOf("\n")).toBe(out.file.length - 1);
		const entry = JSON.parse(out.file) as Record<string, unknown>;
		expect(Object.keys(entry)).toEqual(["timestamp", "level", "pid", "message", "count", "nested"]);
		expect(entry).toMatchObject({
			level: "info",
			pid: process.pid,
			message: "line-format: plain",
			count: 3,
			nested: { ok: true },
		});
	});

	it("stamps local wall-clock time with the offset that makes it an instant", () => {
		const before = Date.now();
		const out = emit(() => logger.warn("line-format: time"));
		const after = Date.now();
		const timestamp = (JSON.parse(out.file) as { timestamp: string }).timestamp;
		const match = TIMESTAMP.exec(timestamp);
		expect(match).not.toBeNull();
		const instant = Date.parse(timestamp);
		// Parsed with its offset, the stamp is the moment of the call to the millisecond.
		expect(instant).toBeGreaterThanOrEqual(before);
		expect(instant).toBeLessThanOrEqual(after);
		// The fields are the local calendar and clock of that moment, and the offset is local.
		const local = new Date(instant);
		const [, year, month, day, hour, minute, second, ms, sign, offH, offM] = match as RegExpExecArray;
		expect([year, month, day, hour, minute, second, ms].map(Number)).toEqual([
			local.getFullYear(),
			local.getMonth() + 1,
			local.getDate(),
			local.getHours(),
			local.getMinutes(),
			local.getSeconds(),
			local.getMilliseconds(),
		]);
		const offsetMinutes = (sign === "-" ? -1 : 1) * (Number(offH) * 60 + Number(offM));
		expect(offsetMinutes + local.getTimezoneOffset()).toBe(0);
	});

	/** A live clock reads under 100 ms one call in ten; fixed instants reach each padding width. */
	it.each([0, 7, 42, 100, 999])("pads %i milliseconds to three digits", ms => {
		const instant = new Date(2026, 0, 2, 3, 4, 5, ms);
		setSystemTime(instant);
		try {
			const out = emit(() => logger.info("line-format: millis"));
			const timestamp = (JSON.parse(out.file) as { timestamp: string }).timestamp;
			expect(TIMESTAMP.exec(timestamp)?.[7]).toBe(String(ms).padStart(3, "0"));
			expect(Date.parse(timestamp)).toBe(instant.getTime());
		} finally {
			setSystemTime();
		}
	});

	/**
	 * The test process may run in UTC, where the sign and the minutes of the offset are never
	 * exercised; a child in a named zone writes the line instead.
	 */
	it.each([
		["America/St_Johns", /-0[23]:30$/],
		["Asia/Kathmandu", /\+05:45$/],
	])("stamps the offset of %s with its sign and minutes", (zone, suffix) => {
		const loggerUrl = pathToFileURL(path.join(import.meta.dirname, "..", "src", "logger.ts")).href;
		const probe = `
			const logger = await import(${JSON.stringify(loggerUrl)});
			logger.setTransports({ file: false, console: true });
			logger.info("line-format: zone");
		`;
		const before = Date.now();
		const run = spawnSync(process.execPath, ["-e", probe], { env: { ...process.env, TZ: zone }, encoding: "utf8" });
		const after = Date.now();
		expect(run.stderr).toBe("");
		const timestamp = (JSON.parse(run.stdout) as { timestamp: string }).timestamp;
		expect(timestamp).toMatch(TIMESTAMP);
		expect(timestamp).toMatch(suffix);
		expect(Date.parse(timestamp)).toBeGreaterThanOrEqual(before);
		expect(Date.parse(timestamp)).toBeLessThanOrEqual(after);
	});

	it("names its level for each of the four methods", () => {
		const methods = [logger.error, logger.warn, logger.info, logger.debug];
		const levels = methods.map(method => {
			const out = emit(() => method("line-format: level"));
			return (JSON.parse(out.file) as { level: string }).level;
		});
		expect(levels).toEqual(["error", "warn", "info", "debug"]);
	});

	it("keeps its own level and timestamp over the context's, and appends a context message", () => {
		const out = emit(() =>
			logger.error("line-format: reserved", {
				level: "debug",
				timestamp: "not a time",
				message: "from the context",
				pid: 1,
			}),
		);
		const entry = JSON.parse(out.file) as Record<string, unknown>;
		expect(entry.level).toBe("error");
		expect(TIMESTAMP.test(String(entry.timestamp))).toBe(true);
		expect(entry.message).toBe("line-format: reserved from the context");
		// `pid` is a context field like any other and replaces the process id.
		expect(entry.pid).toBe(1);
		expect(Object.keys(entry)).toEqual(["timestamp", "level", "pid", "message"]);
	});

	it("drops an empty context message rather than appending a space", () => {
		const out = emit(() => logger.info("line-format: empty", { message: "" }));
		expect((JSON.parse(out.file) as { message: string }).message).toBe("line-format: empty");
	});
});
