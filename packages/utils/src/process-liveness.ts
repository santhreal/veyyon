import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { dlopen, FFIType, ptr } from "bun:ffi";

/**
 * Whether the process with this pid still exists.
 *
 * This is the one owner of that question. It was hand-rolled in seven places
 * under three different names, and the copies disagreed on the case that
 * matters: what `process.kill(pid, 0)` throwing actually means.
 *
 * Sending signal 0 does not send a signal. It performs the error checks that a
 * real signal would, so it answers "could I signal this process?" and the kernel
 * distinguishes two failures:
 *
 * - `ESRCH`, no such process. The process is gone, and this returns false.
 * - `EPERM`, the process exists but belongs to a user you may not signal. It is
 *   alive, and this returns true.
 *
 * The naive form catches everything and reports dead, which is wrong under a
 * container, a sandbox, or any setup where the pid belongs to another user. That
 * matters most where liveness decides whether to reap something: a lock whose
 * owner is wrongly judged dead is taken from a live holder, and two processes
 * end up inside a critical section that was supposed to admit one.
 *
 * Liveness alone cannot distinguish the original owner from an unrelated
 * process that later reused its PID. Destructive callers pair this predicate
 * with {@link getProcessStartIdentity}; a platform that cannot prove process
 * incarnation must fail closed rather than reap from a merely-live PID.
 */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// Only "no such process" proves death. Anything else, most importantly
		// EPERM, means the process is there and we simply may not signal it.
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

const MAX_PROC_IDENTITY_BYTES = 4_096;
const SYSTEM_QUERY_TIMEOUT_MS = 2_000;

export interface ProcessIdentityDependencies {
	platform: NodeJS.Platform;
	readBoundedTextFile(filePath: string): string | null;
	querySystem(executable: string, args: readonly string[]): string | null;
	queryDarwinProcessStart(pid: number): string | null;
	queryWindowsProcessStart(pid: number): string | null;
}

function readBoundedTextFileSync(filePath: string): string | null {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, fs.constants.O_RDONLY);
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > MAX_PROC_IDENTITY_BYTES) return null;
		// procfs reports many virtual files as size 0. A fixed upper-bound read
		// still prevents allocation from depending on kernel-provided content.
		const bytes = Buffer.allocUnsafe(MAX_PROC_IDENTITY_BYTES + 1);
		const bytesRead = fs.readSync(fd, bytes, 0, bytes.length, 0);
		if (bytesRead < 1 || bytesRead > MAX_PROC_IDENTITY_BYTES) return null;
		return bytes.subarray(0, bytesRead).toString("utf8").trim();
	} catch {
		return null;
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// A failed close cannot make an unverified identity trustworthy.
			}
		}
	}
}

function querySystemTextSync(executable: string, args: readonly string[]): string | null {
	try {
		const output = execFileSync(executable, [...args], {
			encoding: "utf8",
			env: { ...process.env, LC_ALL: "C", LANG: "C" },
			maxBuffer: MAX_PROC_IDENTITY_BYTES + 1,
			stdio: ["ignore", "pipe", "ignore"],
			timeout: SYSTEM_QUERY_TIMEOUT_MS,
			windowsHide: true,
		});
		if (Buffer.byteLength(output, "utf8") > MAX_PROC_IDENTITY_BYTES) return null;
		const normalized = output.trim();
		return normalized.length > 0 ? normalized : null;
	} catch {
		return null;
	}
}

function queryDarwinProcessStartSync(pid: number): string | null {
	if (process.platform !== "darwin") return null;
	try {
		const libproc = dlopen("/usr/lib/libproc.dylib", {
			proc_pidinfo: {
				args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
				returns: FFIType.i32,
			},
		});
		try {
			// PROC_PIDTBSDINFO returns proc_bsdinfo. Its final two uint64 fields
			// are the start timeval seconds/useconds at offsets 120 and 128.
			const bsdInfo = new Uint8Array(136);
			const bytes = libproc.symbols.proc_pidinfo(pid, 3, 0n, ptr(bsdInfo), bsdInfo.byteLength);
			if (bytes < bsdInfo.byteLength) return null;
			const view = new DataView(bsdInfo.buffer, bsdInfo.byteOffset, bsdInfo.byteLength);
			const seconds = view.getBigUint64(120, true);
			const microseconds = view.getBigUint64(128, true);
			return seconds > 0n && microseconds < 1_000_000n ? `${seconds}.${microseconds}` : null;
		} finally {
			libproc.close();
		}
	} catch {
		return null;
	}
}

function queryWindowsProcessStartSync(pid: number): string | null {
	if (process.platform !== "win32") return null;
	try {
		const kernel32 = dlopen("kernel32.dll", {
			OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.ptr },
			GetProcessTimes: {
				args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
				returns: FFIType.bool,
			},
			CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
		});
		try {
			// PROCESS_QUERY_LIMITED_INFORMATION is sufficient for GetProcessTimes
			// and avoids asking for mutation/debug rights.
			const handle = kernel32.symbols.OpenProcess(0x1000, false, pid);
			if (handle === null || handle === 0) return null;
			try {
				const creation = new Uint32Array(2);
				const exit = new Uint32Array(2);
				const kernel = new Uint32Array(2);
				const user = new Uint32Array(2);
				if (
					!kernel32.symbols.GetProcessTimes(
						handle,
						ptr(creation),
						ptr(exit),
						ptr(kernel),
						ptr(user),
					)
				) {
					return null;
				}
				const fileTime = (BigInt(creation[1]!) << 32n) | BigInt(creation[0]!);
				return fileTime > 0n ? fileTime.toString() : null;
			} finally {
				kernel32.symbols.CloseHandle(handle);
			}
		} finally {
			kernel32.close();
		}
	} catch {
		return null;
	}
}

const DEFAULT_PROCESS_IDENTITY_DEPENDENCIES: ProcessIdentityDependencies = {
	platform: process.platform,
	readBoundedTextFile: readBoundedTextFileSync,
	querySystem: querySystemTextSync,
	queryDarwinProcessStart: queryDarwinProcessStartSync,
	queryWindowsProcessStart: queryWindowsProcessStartSync,
};

function getLinuxProcessStartIdentity(pid: number, dependencies: ProcessIdentityDependencies): string | null {
	const bootId = dependencies.readBoundedTextFile("/proc/sys/kernel/random/boot_id");
	const stat = dependencies.readBoundedTextFile(`/proc/${pid}/stat`);
	if (!bootId || !/^[0-9a-f-]{36}$/i.test(bootId) || !stat) return null;

	// `comm` is parenthesized and may itself contain spaces or `)`, so split only
	// after its final closing parenthesis. The remainder starts at proc field 3;
	// field 22 (`starttime`) is therefore index 19.
	const commandEnd = stat.lastIndexOf(")");
	if (commandEnd < 2 || stat[commandEnd + 1] !== " ") return null;
	const fields = stat.slice(commandEnd + 2).split(/\s+/);
	const startTime = fields[19];
	if (!startTime || !/^\d+$/.test(startTime)) return null;
	return `linux:${bootId.toLowerCase()}:${startTime}`;
}

function getDarwinProcessStartIdentity(pid: number, dependencies: ProcessIdentityDependencies): string | null {
	const bootTime = dependencies.querySystem("/usr/sbin/sysctl", ["-n", "kern.boottime"]);
	const processStart = dependencies.queryDarwinProcessStart(pid);
	if (!bootTime || !processStart || !/^\d+\.\d+$/.test(processStart)) return null;
	const bootMatch = /\bsec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/.exec(bootTime);
	if (!bootMatch) return null;
	return `darwin:${bootMatch[1]}.${bootMatch[2]}:${processStart}`;
}

function getWindowsProcessStartIdentity(pid: number, dependencies: ProcessIdentityDependencies): string | null {
	const processCreationFileTime = dependencies.queryWindowsProcessStart(pid);
	return processCreationFileTime && /^\d{10,20}$/.test(processCreationFileTime)
		? `win32:${processCreationFileTime}`
		: null;
}

/**
 * Return an OS-verifiable boot + start identity for one incarnation of `pid`.
 *
 * Linux uses procfs boot UUID/start ticks, macOS combines bounded `sysctl`
 * boot time with native `proc_pidinfo` start time, and Windows calls
 * `OpenProcess`/`GetProcessTimes` directly. Native calls use Bun FFI; no path
 * constructs or invokes a command shell. A
 * failed or malformed query returns `null`, which destructive callers treat as
 * unverifiable and live.
 */
export function getProcessStartIdentity(
	pid: number,
	dependencies: ProcessIdentityDependencies = DEFAULT_PROCESS_IDENTITY_DEPENDENCIES,
): string | null {
	if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) return null;
	switch (dependencies.platform) {
		case "linux":
			return getLinuxProcessStartIdentity(pid, dependencies);
		case "darwin":
			return getDarwinProcessStartIdentity(pid, dependencies);
		case "win32":
			return getWindowsProcessStartIdentity(pid, dependencies);
		default:
			return null;
	}
}

/**
 * Whether `pid` is still the same process incarnation recorded by an owner.
 *
 * Missing identity support or an unreadable process record is deliberately
 * treated as alive. Destructive recovery is allowed only when death or PID
 * reuse is proven; an EPERM/sandbox failure therefore costs availability, not
 * mutual exclusion.
 */
export function isProcessInstanceAlive(
	pid: number,
	expectedIdentity: string | null,
	dependencies: ProcessIdentityDependencies = DEFAULT_PROCESS_IDENTITY_DEPENDENCIES,
): boolean {
	if (!isProcessAlive(pid)) return false;
	if (expectedIdentity === null) return true;
	const actualIdentity = getProcessStartIdentity(pid, dependencies);
	return actualIdentity === null || actualIdentity === expectedIdentity;
}
