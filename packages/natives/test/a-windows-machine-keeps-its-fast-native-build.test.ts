import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { classifyAvx2Support, parseHostVariantVerdict, writeHostVariantVerdict } from "../native/loader-state.js";

/**
 * WHY: stock Windows PowerShell 5.1 runs .NET Framework, which has no
 * `System.Runtime.Intrinsics.X86.Avx2` type. The old single-shell probe
 * therefore failed on EVERY stock Windows machine and the loader silently
 * pinned the slower `baseline` addon forever. These tests close the class
 * "an AVX2 verdict comes from an unrepresentative probe": the detector must
 * try every installed Windows shell before answering, must treat garbage or
 * unrunnable shells as "unknown" rather than "unsupported", must fall through
 * to a child-process trial load of the modern addon when no shell can answer
 * (the stock-Windows case: the child dying on an illegal instruction is ground
 * truth, not a guess), and must persist ONLY genuine verdicts so later
 * launches skip the probe without ever remembering a guess.
 */

const AVX2_COMMAND = "[System.Runtime.Intrinsics.X86.Avx2]::IsSupported";

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

describe("persisted host variant verdict", () => {
	it("reads back what was written for the same hardware", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-variant-"));
		try {
			writeHostVariantVerdict(dir, "supported", { platform: "win32", arch: "x64" });
			const text = fs.readFileSync(path.join(dir, "host-variant.json"), "utf8");
			expect(parseHostVariantVerdict(text, { platform: "win32", arch: "x64" })).toBe("supported");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("never accepts a verdict from other hardware, corruption, or a recorded guess", () => {
		const same = { platform: "win32" as const, arch: "x64" };
		expect(
			parseHostVariantVerdict(JSON.stringify({ platform: "linux", arch: "x64", verdict: "supported" }), same),
		).toBeNull();
		expect(
			parseHostVariantVerdict(JSON.stringify({ platform: "win32", arch: "arm64", verdict: "supported" }), same),
		).toBeNull();
		expect(parseHostVariantVerdict("{not json", same)).toBeNull();
		expect(parseHostVariantVerdict("42", same)).toBeNull();
		// An "unknown" answer is not an answer: persisting it would pin the
		// slower build on hardware we simply failed to ask.
		expect(
			parseHostVariantVerdict(JSON.stringify({ platform: "win32", arch: "x64", verdict: "unknown" }), same),
		).toBeNull();
	});
});
