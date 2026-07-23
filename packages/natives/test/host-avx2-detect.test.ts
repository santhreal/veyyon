import { describe, expect, it } from "bun:test";
import { classifyHostAvx2Support, type HostProbes } from "../../../scripts/host-detect";

/**
 * Build-time twin of the runtime AVX2 tri-state (issue-3238-repro.test.ts). The
 * build host detector decides which x64 variant `build-native.ts` produces when
 * TARGET_VARIANT is unset. The old boolean version returned `false` for BOTH
 * "no AVX2" and "could not probe", so a build host with an unreadable
 * `/proc/cpuinfo` or a failing `sysctl` silently produced a `baseline`-only
 * artifact even on an AVX2 machine (Law 10: a silent, materially-slower
 * downgrade). `classifyHostAvx2Support` now distinguishes the two, and these
 * tests pin every platform branch — including the failure paths that used to
 * masquerade as "unsupported" — through injected probes, so no real host is
 * needed and the failure modes are actually reachable in a test.
 */

function probes(overrides: Partial<HostProbes>): HostProbes {
	return {
		platform: "linux",
		arch: "x64",
		readCpuInfo: () => "flags: fpu avx avx2 sse\n",
		runCommand: () => null,
		...overrides,
	};
}

describe("classifyHostAvx2Support — architecture gate", () => {
	it("reports unsupported for any non-x64 arch without probing", () => {
		for (const arch of ["arm64", "ia32", "ppc64"]) {
			expect(classifyHostAvx2Support(probes({ arch }))).toBe("unsupported");
		}
	});
});

describe("classifyHostAvx2Support — linux /proc/cpuinfo", () => {
	it("supported when cpuinfo lists the avx2 flag", () => {
		expect(classifyHostAvx2Support(probes({ platform: "linux", readCpuInfo: () => "flags: sse4_2 avx avx2\n" }))).toBe(
			"supported",
		);
	});

	it("unsupported when cpuinfo is readable but has no avx2 flag", () => {
		expect(classifyHostAvx2Support(probes({ platform: "linux", readCpuInfo: () => "flags: sse4_2 avx\n" }))).toBe(
			"unsupported",
		);
	});

	it("UNKNOWN (not unsupported) when /proc/cpuinfo cannot be read", () => {
		// The exact silent-downgrade bug: an unreadable cpuinfo must not be
		// mistaken for "this CPU has no AVX2".
		expect(classifyHostAvx2Support(probes({ platform: "linux", readCpuInfo: () => null }))).toBe("unknown");
	});
});

describe("classifyHostAvx2Support — darwin sysctl", () => {
	it("supported when leaf7_features reports AVX2", () => {
		const run = (_c: string, args: string[]) => (args[1] === "machdep.cpu.leaf7_features" ? "AVX2 BMI1 BMI2" : null);
		expect(classifyHostAvx2Support(probes({ platform: "darwin", runCommand: run }))).toBe("supported");
	});

	it("supported when the fallback features key reports AVX2", () => {
		const run = (_c: string, args: string[]) =>
			args[1] === "machdep.cpu.features" ? "FPU VME ... AVX1.0 AVX2" : args[1] === "machdep.cpu.leaf7_features" ? "BMI1 BMI2" : null;
		expect(classifyHostAvx2Support(probes({ platform: "darwin", runCommand: run }))).toBe("supported");
	});

	it("unsupported when sysctl RAN and reported no AVX2", () => {
		const run = () => "SSE4.2 BMI1"; // a real, AVX2-less answer
		expect(classifyHostAvx2Support(probes({ platform: "darwin", runCommand: run }))).toBe("unsupported");
	});

	it("UNKNOWN when every sysctl spawn failed (issue #3238's failing spawn context)", () => {
		// Neither key produced output: the probe could not run, so the verdict is
		// unknown, never a false 'unsupported' that bricks the modern build.
		expect(classifyHostAvx2Support(probes({ platform: "darwin", runCommand: () => null }))).toBe("unknown");
	});
});

describe("classifyHostAvx2Support — win32 powershell", () => {
	it("supported when powershell prints True", () => {
		expect(classifyHostAvx2Support(probes({ platform: "win32", arch: "x64", runCommand: () => "True" }))).toBe("supported");
	});

	it("unsupported when powershell prints False", () => {
		expect(classifyHostAvx2Support(probes({ platform: "win32", arch: "x64", runCommand: () => "False" }))).toBe(
			"unsupported",
		);
	});

	it("UNKNOWN when powershell could not run", () => {
		expect(classifyHostAvx2Support(probes({ platform: "win32", arch: "x64", runCommand: () => null }))).toBe("unknown");
	});
});
