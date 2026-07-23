import * as fs from "node:fs";

/**
 * Tri-state AVX2 detection, matching the shipped runtime loader's
 * `detectAvx2Support` (packages/natives/native/loader-state.js). Kept as a
 * separate implementation on purpose — this is a build-time script and that is
 * shipped runtime `.js`, so neither should import the other across that
 * boundary — but the SEMANTICS are identical and must stay in lock-step:
 *
 *   - `"supported"`   — the probe ran and the CPU has AVX2.
 *   - `"unsupported"` — the probe ran and the CPU lacks AVX2.
 *   - `"unknown"`     — the probe could not run at all.
 *
 * The distinction matters at build time too (Law 10): the old boolean detector
 * returned `false` for both "no AVX2" and "couldn't detect", so a build host
 * whose `/proc/cpuinfo` was unreadable or whose `sysctl` failed to spawn would
 * silently produce a `baseline`-only artifact on a machine that supports the
 * faster `modern` build. `build-native.ts` reads the tri-state so it can warn
 * (and let the developer set TARGET_VARIANT) instead of guessing silently.
 */
export type Avx2Support = "supported" | "unsupported" | "unknown";

/** Injectable probes so the platform branches are unit-testable without the real host. */
export interface HostProbes {
	platform: NodeJS.Platform;
	arch: string;
	readCpuInfo: () => string | null;
	runCommand: (command: string, args: string[]) => string | null;
}

function realRunCommand(command: string, args: string[]): string | null {
	try {
		const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) return null;
		return result.stdout.toString("utf-8").trim();
	} catch {
		return null;
	}
}

function realReadCpuInfo(): string | null {
	try {
		return fs.readFileSync("/proc/cpuinfo", "utf8");
	} catch {
		return null;
	}
}

function defaultProbes(): HostProbes {
	return {
		platform: process.platform,
		arch: process.arch,
		readCpuInfo: realReadCpuInfo,
		runCommand: realRunCommand,
	};
}

/**
 * Classify AVX2 support from injected probes. Pure with respect to `probes`, so
 * every platform branch — including the "probe could not run" path that used to
 * masquerade as "unsupported" — is directly testable.
 */
export function classifyHostAvx2Support(probes: HostProbes): Avx2Support {
	if (probes.arch !== "x64") return "unsupported";

	if (probes.platform === "linux") {
		const cpuInfo = probes.readCpuInfo();
		// A null read means we could not inspect the CPU — do NOT claim absent.
		if (cpuInfo === null) return "unknown";
		return /\bavx2\b/i.test(cpuInfo) ? "supported" : "unsupported";
	}

	if (probes.platform === "darwin") {
		let anyProbeRan = false;
		for (const key of ["machdep.cpu.leaf7_features", "machdep.cpu.features"]) {
			const out = probes.runCommand("sysctl", ["-n", key]);
			if (out !== null) anyProbeRan = true;
			if (out && /\bAVX2\b/i.test(out)) return "supported";
		}
		return anyProbeRan ? "unsupported" : "unknown";
	}

	if (probes.platform === "win32") {
		const output = probes.runCommand("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"[System.Runtime.Intrinsics.X86.Avx2]::IsSupported",
		]);
		if (output === null) return "unknown";
		return output.toLowerCase() === "true" ? "supported" : "unsupported";
	}

	return "unknown";
}

/** Detect AVX2 support on the real build host as a tri-state. */
export function detectHostAvx2Support(): Avx2Support {
	return classifyHostAvx2Support(defaultProbes());
}
