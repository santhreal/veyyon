import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { type LocalTime, localCalendarDate } from "@veyyon/utils/local-time";
import { TempDir } from "@veyyon/utils/temp";

/**
 * WHY. `localTime` is the one reader of local calendar and clock fields for the logger's line
 * stamps, its day file, the terminal guard's redirect target and the date the session states to the
 * model. On Linux and macOS it reads them from the C library's `localtime_r`, because a `Date`'s
 * first local-time read builds the engine's ICU time zone cache, which no launch otherwise needs.
 * The class closed here is that reader disagreeing with a `Date`: a misread `struct tm` field or
 * `tm_gmtoff`, a `time_t` written wrong (before 1970 or past 2106, where its high word is set), an
 * offset lost on a half-hour or 45-minute zone or across a daylight saving change, or the C
 * library's zone used where `Date` reads another one, which happens when `process.env.TZ` is
 * assigned at run time.
 *
 * Each zone runs in its own process with that zone in the launch environment. Every instant is
 * read through `localTime` before anything reads a `Date`'s local fields, and the Date getters are
 * counted while it runs, so on Linux and macOS a sweep that passed by falling back to `Date` fails.
 *
 * A POSIX rule string is the one `TZ` form where the two readers part: ICU does not parse one, and
 * `localtime_r` applies the rule. The suite pins the C library's reading, which equals the IANA zone
 * the rule spells, so the logger stamps the zone the launch environment names.
 *
 * NOT closed here: the Windows path is the `Date` fallback, which this suite does not run on.
 */

const LOCAL_TIME_MODULE = path.join(import.meta.dirname, "..", "src", "local-time.ts");

/**
 * Zones with an offset that is not a whole hour, a daylight saving rule, or a day-line extreme, plus
 * a colon-prefixed name and a name neither reader resolves, which both read as UTC.
 */
const ZONES = [
	"Etc/UTC",
	"Etc/GMT+12",
	"Etc/GMT-14",
	"America/New_York",
	"Europe/London",
	"America/St_Johns",
	"Asia/Kathmandu",
	"Pacific/Chatham",
	"Australia/Lord_Howe",
	"Asia/Kolkata",
	":America/New_York",
	"Not/AZone",
];

/** Instants around daylight saving changes, year and leap-day edges, 1970 and the 2^32-second mark. */
const INSTANTS = [
	"1969-12-31T23:59:59.999Z",
	"1970-01-01T00:00:00.000Z",
	"2024-02-29T23:30:00.500Z",
	"2024-03-10T06:59:59.999Z",
	"2024-03-10T07:00:00.000Z",
	"2024-03-31T00:59:59.000Z",
	"2024-03-31T01:00:00.000Z",
	"2024-04-06T14:59:59.000Z",
	"2024-04-06T15:00:00.000Z",
	"2024-11-03T05:59:59.999Z",
	"2024-11-03T06:00:00.001Z",
	"2025-12-31T23:59:59.999Z",
	"2106-02-07T06:28:16.000Z",
	"2200-06-15T12:34:56.789Z",
].map(iso => Date.parse(iso));

interface Report {
	/** Instants whose `localTime` fields differ from the `Date`'s, with both readings. */
	mismatches: { ms: number; localTime: unknown; date: unknown }[];
	/** `localTime` of each instant, in order. */
	read: LocalTime[];
	/** Date local getters called while `localTime` ran. */
	dateReads: number;
}

let temp: TempDir;

beforeAll(() => {
	temp = TempDir.createSync("@local-time-");
});

afterAll(() => {
	temp.removeSync();
});

/** Reads every instant in a process launched with `launchTz`, after assigning `runtimeTz` when given. */
function readZone(launchTz: string | undefined, runtimeTz?: string): Report {
	const probe = path.join(temp.path(), `probe-${Math.random().toString(36).slice(2)}.ts`);
	fs.writeFileSync(
		probe,
		[
			`import { localTime } from ${JSON.stringify(LOCAL_TIME_MODULE)};`,
			runtimeTz === undefined ? "" : `process.env.TZ = ${JSON.stringify(runtimeTz)};`,
			`const instants = ${JSON.stringify(INSTANTS)};`,
			`let dateReads = 0;`,
			`const getters = Object.getOwnPropertyNames(Date.prototype).filter(n => /^get(?!UTC|Time$)/.test(n));`,
			`const originals = getters.map(n => [n, Date.prototype[n]]);`,
			`for (const [n, f] of originals) Date.prototype[n] = function (...a) { dateReads++; return f.apply(this, a); };`,
			`const read = instants.map(ms => localTime(ms));`,
			`const counted = dateReads;`,
			`for (const [n, f] of originals) Date.prototype[n] = f;`,
			`const mismatches = [];`,
			`instants.forEach((ms, i) => {`,
			`  const d = new Date(ms);`,
			`  const date = { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hours: d.getHours(), minutes: d.getMinutes(), seconds: d.getSeconds(), milliseconds: d.getMilliseconds(), offsetMinutes: -d.getTimezoneOffset() };`,
			`  if (JSON.stringify(date) !== JSON.stringify(read[i])) mismatches.push({ ms, localTime: read[i], date });`,
			`});`,
			`process.stdout.write(JSON.stringify({ mismatches, read, dateReads: counted }));`,
		].join("\n"),
	);
	const env: Record<string, string | undefined> = { ...process.env };
	delete env.TZ;
	if (launchTz !== undefined) env.TZ = launchTz;
	const run = spawnSync(process.execPath, [probe], { env, encoding: "utf8" });
	expect(run.stderr).toBe("");
	expect(run.status).toBe(0);
	return JSON.parse(run.stdout) as Report;
}

/** Linux and macOS read through the C library; elsewhere `localTime` reads a `Date` by design. */
const READS_THE_C_LIBRARY = process.platform === "linux" || process.platform === "darwin";

describe("localTime", () => {
	it.each(ZONES)("reads what a Date reads in %s, without reading a Date", zone => {
		const report = readZone(zone);
		expect(report.read).toHaveLength(INSTANTS.length);
		expect(report.mismatches).toEqual([]);
		if (READS_THE_C_LIBRARY) expect(report.dateReads).toBe(0);
	});

	it("reads what a Date reads in the system zone when TZ is unset", () => {
		const report = readZone(undefined);
		expect(report.mismatches).toEqual([]);
		if (READS_THE_C_LIBRARY) expect(report.dateReads).toBe(0);
	});

	it("follows a zone assigned to process.env.TZ at run time, which only Date sees", () => {
		// Launch and run-time zones 26 hours apart disagree on the day of every instant.
		const report = readZone("Etc/GMT+12", "Etc/GMT-14");
		expect(report.mismatches).toEqual([]);
		expect(report.dateReads).toBeGreaterThan(0);
	});

	it.if(READS_THE_C_LIBRARY).each([
		["<+0530>-5:30", "Asia/Kolkata"],
		["EST5EDT,M3.2.0,M11.1.0", "America/New_York"],
	])("applies the POSIX rule %s as the zone %s, which ICU does not parse", (rule, zone) => {
		const report = readZone(rule);
		expect(report.read).toEqual(readZone(zone).read);
		expect(report.dateReads).toBe(0);
	});
});

describe("localCalendarDate", () => {
	// Noon UTC is the same local day for offsets up to +11:59 and the next one from +12:00, so each
	// pattern admits both and holds in every host zone.
	it("pads a one-digit month and day to two digits", () => {
		expect(localCalendarDate(Date.UTC(2025, 0, 5, 12))).toMatch(/^2025-01-0[56]$/);
	});

	it("writes a two-digit month and day unpadded", () => {
		expect(localCalendarDate(Date.UTC(2025, 11, 20, 12))).toMatch(/^2025-12-2[01]$/);
	});

	it("writes the year as it is, without padding", () => {
		expect(localCalendarDate(Date.UTC(999, 6, 15, 12))).toMatch(/^999-07-1[56]$/);
	});
});
