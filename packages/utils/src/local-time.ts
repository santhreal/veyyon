/**
 * Local calendar date and clock time of an instant, read without building the engine's ICU time
 * zone cache.
 *
 * The first local-time read of a `Date` builds JavaScriptCore's ICU time zone cache. MEASURED on
 * linux-x64: 2.2 ms and 1.9 MiB of private memory, in each thread that reads one. Every launch reads
 * the local day: the logger stamps each line in local time and names its file by the day, and the
 * session hashes the day into its tool signature and states it to the model. On Linux and macOS the
 * fields come from the C library's `localtime_r`, which reads the same zone database in 0.03 ms
 * after a 0.1 ms `dlopen`. Node has no local-time call besides `Date`.
 *
 * The C library reads `TZ` from the launch environment, and Bun applies a later `process.env.TZ`
 * assignment to `Date` alone. While the two disagree, and on Windows, the fields come from a `Date`,
 * so this module and a `Date` built in the same process name the same local time. A POSIX rule
 * string (`<+0530>-5:30`, `EST5EDT,M3.2.0,M11.1.0`) is the exception: ICU does not parse one and
 * `Date` reads another zone, while `localtime_r` applies the rule.
 */
import { CString, dlopen, FFIType, type Pointer } from "bun:ffi";

/** An instant's local calendar date and clock time. */
export interface LocalTime {
	year: number;
	/** 1 for January. */
	month: number;
	day: number;
	hours: number;
	minutes: number;
	seconds: number;
	milliseconds: number;
	/** Minutes east of UTC, negative west of it. */
	offsetMinutes: number;
}

interface LocalTimeLibc {
	localtime_r(time: Uint32Array, tm: Int32Array): Pointer | bigint | null;
	/** `TZ` as the C library read it from the launch environment; `undefined` when unset. */
	tz: string | undefined;
}

let libcCache: LocalTimeLibc | null | undefined;

function libc(): LocalTimeLibc | null {
	if (libcCache !== undefined) return libcCache;
	libcCache = null;
	if (process.platform !== "darwin" && process.platform !== "linux") return null;
	// Darwin: dyld resolves libSystem from the shared cache. Linux: glibc first, then the generic
	// soname for musl-style layouts.
	const candidates =
		process.platform === "darwin" ? ["libSystem.B.dylib", "/usr/lib/libSystem.B.dylib"] : ["libc.so.6", "libc.so"];
	for (const candidate of candidates) {
		try {
			const { symbols } = dlopen(candidate, {
				getenv: { args: [FFIType.ptr], returns: FFIType.ptr },
				tzset: { args: [], returns: FFIType.void },
				localtime_r: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
			});
			// POSIX does not require `localtime_r` to load the zone, so it is loaded once here. A
			// `process.env` assignment never reaches the C environment, so `TZ` is read once too.
			symbols.tzset();
			const tz = symbols.getenv(Buffer.from("TZ\0"));
			libcCache = { localtime_r: symbols.localtime_r, tz: tz === null ? undefined : new CString(tz).toString() };
			return libcCache;
		} catch {
			// Try the next candidate; every read falls back to `Date` if none load.
		}
	}
	return libcCache;
}

/** `time_t` seconds, written as two 32-bit halves so no `BigInt` is built per read. */
const timeBuffer = new Uint32Array(2);
/**
 * `struct tm`: nine ints (sec, min, hour, mday, mon, year, wday, yday, isdst), then `long tm_gmtoff`
 * at byte 40 on glibc, musl and Darwin, 56 bytes on each. Both supported architectures are
 * little-endian, so int 10 is the low word of `tm_gmtoff`, which holds the whole offset.
 */
const tmBuffer = new Int32Array(16);

/** Local calendar date and clock time of `ms`, epoch milliseconds. */
export function localTime(ms: number): LocalTime {
	const c = libc();
	if (c !== null && c.tz === process.env.TZ) {
		const seconds = Math.floor(ms / 1000);
		timeBuffer[0] = seconds % 0x1_0000_0000;
		timeBuffer[1] = Math.floor(seconds / 0x1_0000_0000);
		if (c.localtime_r(timeBuffer, tmBuffer) !== null) {
			return {
				year: tmBuffer[5] + 1900,
				month: tmBuffer[4] + 1,
				day: tmBuffer[3],
				hours: tmBuffer[2],
				minutes: tmBuffer[1],
				seconds: tmBuffer[0],
				milliseconds: ms - seconds * 1000,
				offsetMinutes: tmBuffer[10] / 60,
			};
		}
	}
	const date = new Date(ms);
	return {
		year: date.getFullYear(),
		month: date.getMonth() + 1,
		day: date.getDate(),
		hours: date.getHours(),
		minutes: date.getMinutes(),
		seconds: date.getSeconds(),
		milliseconds: date.getMilliseconds(),
		offsetMinutes: -date.getTimezoneOffset(),
	};
}

/** `YYYY-MM-DD` of the local calendar day of `ms`, epoch milliseconds; the year is not padded. */
export function localCalendarDate(ms: number): string {
	const { year, month, day } = localTime(ms);
	return `${year}-${month < 10 ? "0" : ""}${month}-${day < 10 ? "0" : ""}${day}`;
}
