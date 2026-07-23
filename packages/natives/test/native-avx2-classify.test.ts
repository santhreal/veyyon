import { describe, expect, it } from "bun:test";
import { classifyHostAvx2Support, type HostProbes } from "../../../scripts/host-detect";
import { classifyAvx2Support } from "../native/loader-state.js";

/**
 * The runtime AVX2 classifier (loader-state.js `classifyAvx2Support`) and the
 * build-time one (scripts/host-detect.ts `classifyHostAvx2Support`) live on
 * opposite sides of the build/runtime boundary and cannot share code, so the
 * same tri-state semantics are implemented twice. This suite is the ONE-PLACE
 * guard against the two drifting: it runs one probe matrix through BOTH and
 * asserts identical verdicts, and it exercises the runtime classifier's own
 * platform branches directly (previously untested — only the mocked `detectAvx2`
 * inside `selectCpuVariant` had coverage, never the real `/proc/cpuinfo` /
 * `sysctl` / powershell parsing).
 *
 * Probes are keyed by sysctl KEY, not by binary path, so the runtime detector's
 * extra `/usr/sbin/sysctl` attempt (the #3238 PATH fix, absent build-side)
 * yields the same classification — parity is about how probe outputs map to a
 * verdict, not which binary paths are tried.
 */

type Case = {
	name: string;
	probes: Omit<HostProbes, "arch"> & { arch?: string };
	expected: "supported" | "unsupported" | "unknown";
};

const CPUINFO_WITH_AVX2 = "flags: fpu sse4_2 avx avx2 bmi2\n";
const CPUINFO_NO_AVX2 = "flags: fpu sse4_2 avx\n";

/** A sysctl mock keyed by the requested key, independent of the binary path used. */
function sysctl(map: Record<string, string | null>) {
	return (_command: string, args: string[]): string | null => {
		const key = args[args.length - 1];
		return key in map ? map[key] : null;
	};
}

const CASES: Case[] = [
	{
		name: "linux, cpuinfo has avx2 -> supported",
		probes: { platform: "linux", readCpuInfo: () => CPUINFO_WITH_AVX2, runCommand: () => null },
		expected: "supported",
	},
	{
		name: "linux, cpuinfo lacks avx2 -> unsupported",
		probes: { platform: "linux", readCpuInfo: () => CPUINFO_NO_AVX2, runCommand: () => null },
		expected: "unsupported",
	},
	{
		name: "linux, cpuinfo unreadable -> unknown",
		probes: { platform: "linux", readCpuInfo: () => null, runCommand: () => null },
		expected: "unknown",
	},
	{
		name: "darwin, leaf7 reports AVX2 -> supported",
		probes: {
			platform: "darwin",
			readCpuInfo: () => null,
			runCommand: sysctl({ "machdep.cpu.leaf7_features": "AVX2 BMI1 BMI2" }),
		},
		expected: "supported",
	},
	{
		name: "darwin, features fallback reports AVX2 -> supported",
		probes: {
			platform: "darwin",
			readCpuInfo: () => null,
			runCommand: sysctl({ "machdep.cpu.leaf7_features": "BMI1", "machdep.cpu.features": "AVX1.0 AVX2" }),
		},
		expected: "supported",
	},
	{
		name: "darwin, probe ran and reported no AVX2 -> unsupported",
		probes: {
			platform: "darwin",
			readCpuInfo: () => null,
			runCommand: sysctl({ "machdep.cpu.leaf7_features": "SSE4.2", "machdep.cpu.features": "SSE4.2 FMA" }),
		},
		expected: "unsupported",
	},
	{
		name: "darwin, every sysctl spawn failed -> unknown",
		probes: { platform: "darwin", readCpuInfo: () => null, runCommand: () => null },
		expected: "unknown",
	},
	{
		name: "win32, powershell prints True -> supported",
		probes: { platform: "win32", readCpuInfo: () => null, runCommand: () => "True" },
		expected: "supported",
	},
	{
		name: "win32, powershell prints False -> unsupported",
		probes: { platform: "win32", readCpuInfo: () => null, runCommand: () => "False" },
		expected: "unsupported",
	},
	{
		name: "win32, powershell could not run -> unknown",
		probes: { platform: "win32", readCpuInfo: () => null, runCommand: () => null },
		expected: "unknown",
	},
	{
		name: "non-x64 arch -> unsupported without probing",
		probes: { platform: "linux", arch: "arm64", readCpuInfo: () => CPUINFO_WITH_AVX2, runCommand: () => null },
		expected: "unsupported",
	},
];

describe("runtime classifyAvx2Support — real platform branches", () => {
	for (const c of CASES) {
		it(c.name, () => {
			expect(classifyAvx2Support({ arch: "x64", ...c.probes })).toBe(c.expected);
		});
	}
});

describe("runtime and build-time AVX2 classifiers agree (no drift across the boundary)", () => {
	for (const c of CASES) {
		it(`parity: ${c.name}`, () => {
			const probes = { arch: "x64", ...c.probes };
			const runtimeVerdict = classifyAvx2Support(probes);
			const buildVerdict = classifyHostAvx2Support(probes);
			expect(runtimeVerdict).toBe(c.expected);
			expect(buildVerdict).toBe(runtimeVerdict);
		});
	}
});
