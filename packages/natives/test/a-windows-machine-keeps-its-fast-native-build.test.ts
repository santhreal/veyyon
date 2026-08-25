import { describe, expect, it } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	classifyAvx2Support,
	classifyTrialLoadResult,
	hostCpuIdentity,
	parseHostVariantVerdict,
	writeHostVariantVerdict,
} from "../native/loader-state.js";

/**
 * WHY: stock Windows PowerShell 5.1 runs .NET Framework, which has no
 * `System.Runtime.Intrinsics.X86.Avx2` type. The old single-shell probe
 * therefore failed on EVERY stock Windows machine and the loader silently
 * pinned the slower `baseline` addon forever. These tests close the class
 * "an AVX2 verdict comes from an unrepresentative probe": the detector must
 * try every installed Windows shell before answering, must treat garbage or
 * unrunnable shells as "unknown" rather than "unsupported", must fall through
 * to a child-process trial load of the modern addon when no shell can answer
 * (only an illegal-instruction exit is ground truth), and must persist only
 * genuine, schema-versioned, CPU-keyed verdicts. An arbitrary addon crash,
 * legacy row, copied cache, or unavailable CPU identity must remain unknown.
 */

const AVX2_COMMAND = "[System.Runtime.Intrinsics.X86.Avx2]::IsSupported";

const CPU_ID = hostCpuIdentity([{ model: "Test CPU with AVX2" }])!;

function scriptedWin32(responses: Record<string, string | null>) {
	return (command: string, args: string[]) => {
		if (!args.includes(AVX2_COMMAND)) return null;
		const output = responses[command];
		if (output === undefined || output === null) return null;
		return output;
	};
}

describe("win32 AVX2 probe tries every installed shell", () => {
	it("answers supported from pwsh alone", () => {
		const verdict = classifyAvx2Support({
			platform: "win32",
			arch: "x64",
			readCpuInfo: () => null,
			runCommand: scriptedWin32({ "pwsh.exe": "True" }),
		});
		expect(verdict).toBe("supported");
	});

	it("falls through to powershell.exe when pwsh cannot run", () => {
		const verdict = classifyAvx2Support({
			platform: "win32",
			arch: "x64",
			readCpuInfo: () => null,
			runCommand: scriptedWin32({ "powershell.exe": "False" }),
		});
		expect(verdict).toBe("unsupported");
	});

	it("a TypeNotFound failure on BOTH shells is unknown, never unsupported", () => {
		// The stock-Windows defect this closes: powershell.exe RUNS but exits
		// non-zero with empty stdout because the type does not exist in .NET
		// Framework. That must not read as "no AVX2".
		const verdict = classifyAvx2Support({
			platform: "win32",
			arch: "x64",
			readCpuInfo: () => null,
			runCommand: () => null,
		});
		expect(verdict).toBe("unknown");
	});

	it("garbage output falls through instead of downgrading", () => {
		const verdict = classifyAvx2Support({
			platform: "win32",
			arch: "x64",
			readCpuInfo: () => null,
			runCommand: scriptedWin32({ "pwsh.exe": "AVX2 support: True", "powershell.exe": "True" }),
		});
		expect(verdict).toBe("supported");
	});
});

describe("win32 AVX2 ground-truth trial load", () => {
	it("consults the child-process trial when no shell can answer", () => {
		let trials = 0;
		const verdict = classifyAvx2Support({
			platform: "win32",
			arch: "x64",
			readCpuInfo: () => null,
			runCommand: () => null,
			trialLoad: () => {
				trials += 1;
				return "supported";
			},
		});
		expect(trials).toBe(1);
		expect(verdict).toBe("supported");
	});

	it("a child that dies loading the addon is a genuine unsupported", () => {
		const verdict = classifyAvx2Support({
			platform: "win32",
			arch: "x64",
			readCpuInfo: () => null,
			runCommand: () => null,
			trialLoad: () => "unsupported",
		});
		expect(verdict).toBe("unsupported");
	});

	it("an inconclusive trial keeps the tri-state at unknown", () => {
		const verdict = classifyAvx2Support({
			platform: "win32",
			arch: "x64",
			readCpuInfo: () => null,
			runCommand: () => null,
			trialLoad: () => "unknown",
		});
		expect(verdict).toBe("unknown");
	});

	it("an explicit shell answer wins and the trial never runs", () => {
		let trials = 0;
		const verdict = classifyAvx2Support({
			platform: "win32",
			arch: "x64",
			readCpuInfo: () => null,
			runCommand: scriptedWin32({ "pwsh.exe": "False" }),
			trialLoad: () => {
				trials += 1;
				return "supported";
			},
		});
		expect(trials).toBe(0);
		expect(verdict).toBe("unsupported");
	});
});

describe("win32 modern-addon trial exit classification", () => {
	it("accepts only a clean success marker as supported", () => {
		expect(classifyTrialLoadResult({ stdout: "TRIAL_OK\n", status: 0, signal: null })).toBe("supported");
		expect(classifyTrialLoadResult({ stdout: "TRIAL_OK\n", status: 0xc0000005, signal: null })).toBe("unknown");
	});

	it("accepts only illegal-instruction exits as unsupported", () => {
		expect(classifyTrialLoadResult({ stdout: "", status: null, signal: "SIGILL" })).toBe("unsupported");
		expect(classifyTrialLoadResult({ stdout: "", status: 0xc000001d, signal: null })).toBe("unsupported");
		expect(classifyTrialLoadResult({ stdout: "", status: -1073741795, signal: null })).toBe("unsupported");
	});

	it("keeps access violations, timeouts, incompatible loads, and unexplained exits unknown", () => {
		expect(classifyTrialLoadResult({ stdout: "", status: 0xc0000005, signal: null })).toBe("unknown");
		expect(classifyTrialLoadResult({ stdout: "TRIAL_INCOMPATIBLE\n", status: 0, signal: null })).toBe("unknown");
		expect(classifyTrialLoadResult({ stdout: "", status: 1, signal: null })).toBe("unknown");
		expect(classifyTrialLoadResult({ stdout: "", status: null, signal: null, error: new Error("timeout") })).toBe(
			"unknown",
		);
	});
});

describe("persisted host variant verdict", () => {
	it("reads back what was written for the same hardware and schema", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-variant-"));
		try {
			writeHostVariantVerdict(dir, "supported", {
				platform: "win32",
				arch: "x64",
				cpuIdentity: CPU_ID,
			});
			const text = fs.readFileSync(path.join(dir, "host-variant.json"), "utf8");
			expect(
				parseHostVariantVerdict(text, {
					platform: "win32",
					arch: "x64",
					cpuIdentity: CPU_ID,
				}),
			).toBe("supported");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("never accepts a legacy, foreign-hardware, corrupt, or guessed verdict", () => {
		const same = { platform: "win32" as const, arch: "x64", cpuIdentity: CPU_ID };
		const row = (overrides: Record<string, unknown> = {}) =>
			JSON.stringify({
				version: 1,
				platform: "win32",
				arch: "x64",
				cpuIdentity: CPU_ID,
				verdict: "supported",
				...overrides,
			});

		expect(parseHostVariantVerdict(row({ version: 0 }), same)).toBeNull();
		expect(parseHostVariantVerdict(row({ platform: "linux" }), same)).toBeNull();
		expect(parseHostVariantVerdict(row({ arch: "arm64" }), same)).toBeNull();
		expect(parseHostVariantVerdict(row({ cpuIdentity: "Replacement CPU" }), same)).toBeNull();
		expect(
			parseHostVariantVerdict(JSON.stringify({ platform: "win32", arch: "x64", verdict: "supported" }), same),
		).toBeNull();
		expect(parseHostVariantVerdict("{not json", same)).toBeNull();
		expect(parseHostVariantVerdict("42", same)).toBeNull();
		expect(parseHostVariantVerdict(row({ verdict: "unknown" }), same)).toBeNull();
	});

	it("does not write without a stable CPU identity", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-variant-"));
		try {
			writeHostVariantVerdict(dir, "supported", {
				platform: "win32",
				arch: "x64",
				cpuIdentity: null,
			});
			expect(fs.existsSync(path.join(dir, "host-variant.json"))).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

/**
 * WHY: the trial load spawns `process.execPath`, and in a compiled
 * distribution that is the product binary, not a JavaScript runtime. It
 * ignores `-e` and boots the whole CLI, which loads natives, reaches this same
 * detector, and spawns a child of its own. The class closed here is "a
 * trial-load child re-enters detection instead of answering it": whatever host
 * runs the child, importing the loader with `VEYYON_TRIAL_ADDON_PATH` set must
 * print one verdict line and end the process there.
 *
 * Not caught: whether a real modern addon raises SIGILL on a CPU without AVX2.
 * That needs such a CPU; `classifyTrialLoadResult` covers the signal mapping.
 */
describe("a trial-load child answers instead of probing again", () => {
	const loaderUrl = new URL("../native/loader-state.js", import.meta.url).href;
	// The child imports by URL computed at run time, and the point of the test
	// is the module-load boundary itself, so the specifier cannot be static.
	const childScript = `await import(${JSON.stringify(loaderUrl)});\nconsole.log("IMPORT_RETURNED");`;

	function runChild(trialAddonPath: string | undefined) {
		const env = { ...process.env };
		delete env.VEYYON_TRIAL_ADDON_PATH;
		if (trialAddonPath !== undefined) env.VEYYON_TRIAL_ADDON_PATH = trialAddonPath;
		return childProcess.spawnSync(process.execPath, ["-e", childScript], {
			env,
			encoding: "utf-8",
			timeout: 30_000,
		});
	}

	it("ends at the first import with an inconclusive verdict when the addon will not load", () => {
		const result = runChild(path.join(os.tmpdir(), "veyyon-no-such-addon.node"));
		expect(result.error).toBeUndefined();
		expect(result.signal).toBeNull();
		expect(result.status).toBe(0);
		expect(String(result.stdout).split(/\r?\n/)).toContain("TRIAL_INCOMPATIBLE");
		expect(String(result.stdout)).not.toContain("IMPORT_RETURNED");
	});

	it("leaves an ordinary import alone", () => {
		const result = runChild(undefined);
		expect(result.error).toBeUndefined();
		expect(result.signal).toBeNull();
		expect(result.status).toBe(0);
		expect(String(result.stdout)).toContain("IMPORT_RETURNED");
		expect(String(result.stdout)).not.toContain("TRIAL_");
	});
});
