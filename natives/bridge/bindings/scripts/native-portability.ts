import { $ } from "bun";

/**
 * The glibc floor every shipped linux-gnu native addon must honor. Owner of the
 * value; `.github/workflows/ci.yml` mirrors it as the `GLIBC_FLOOR` env (a
 * workflow cannot import TS — `native-portability.test.ts` locks the two in
 * sync). Building against a NEWER host glibc silently produces an addon that
 * hard-fails (`GLIBC_2.39 not found`) on any older distro, which is exactly the
 * host-only trap this module exists to surface.
 */
export const GLIBC_FLOOR = "2.17";

/** The zigbuild-pinned triple for a linux-gnu build honoring {@link GLIBC_FLOOR}. */
export function pinnedLinuxGnuTriple(arch: string): string {
	switch (arch) {
		case "x64":
			return `x86_64-unknown-linux-gnu.${GLIBC_FLOOR}`;
		case "arm64":
			return `aarch64-unknown-linux-gnu.${GLIBC_FLOOR}`;
		default:
			throw new Error(`No pinned linux-gnu triple for arch ${arch}`);
	}
}

export type LinuxNativeRoute =
	/** Explicit CROSS_TARGET: the caller controls portability. */
	| { kind: "explicitCross"; target: string }
	/** zig + cargo-zigbuild present: build at the release glibc floor, like CI. */
	| { kind: "zigbuild"; target: string }
	/** No zig toolchain: build against host glibc and warn loudly (host-only). */
	| { kind: "hostOnly"; reason: string };

/**
 * Decide how a linux-gnu native build routes. Pure so the decision is testable:
 * the silent-portability trap this prevents is a local `dist/vey` that LOOKS
 * distributable but links the host's glibc (2.39 on Ubuntu 24.04) and dies on
 * every older distro, while CI's zigbuild path pins {@link GLIBC_FLOOR}.
 */
export function planLinuxNativeRoute(options: {
	crossTarget: string | undefined;
	platform: string;
	arch: string;
	zigAvailable: boolean;
	cargoZigbuildAvailable: boolean;
	hostOnlyOverride: boolean;
}): LinuxNativeRoute | null {
	const { crossTarget, platform, arch, zigAvailable, cargoZigbuildAvailable, hostOnlyOverride } = options;
	if (crossTarget) return { kind: "explicitCross", target: crossTarget };
	if (platform !== "linux") return null;
	if (arch !== "x64" && arch !== "arm64") return null;
	if (hostOnlyOverride) return { kind: "hostOnly", reason: "VEYYON_NATIVE_HOST_ONLY=1 requested a host-glibc build" };
	if (!zigAvailable) return { kind: "hostOnly", reason: "zig is not installed" };
	if (!cargoZigbuildAvailable) return { kind: "hostOnly", reason: "cargo-zigbuild is not installed" };
	return { kind: "zigbuild", target: pinnedLinuxGnuTriple(arch) };
}

/**
 * Highest `GLIBC_x.y` version the ELF's dynamic symbols require, from
 * `readelf -W --dyn-syms` output. Null when the binary requires no versioned
 * glibc symbols (static/musl) — that is trivially portable.
 */
export function maxGlibcRequirement(readelfDynSyms: string): string | null {
	let max: number[] | null = null;
	let maxText: string | null = null;
	for (const match of readelfDynSyms.matchAll(/@GLIBC_([0-9]+(?:\.[0-9]+)+)/g)) {
		const text = match[1]!;
		const parts = text.split(".").map(Number);
		if (max === null || compareVersionParts(parts, max) > 0) {
			max = parts;
			maxText = text;
		}
	}
	return maxText;
}

/** True when `version` (e.g. "2.39") exceeds `floor` (e.g. "2.17"). */
export function exceedsGlibcFloor(version: string, floor: string): boolean {
	return compareVersionParts(version.split(".").map(Number), floor.split(".").map(Number)) > 0;
}

function compareVersionParts(a: number[], b: number[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const delta = (a[i] ?? 0) - (b[i] ?? 0);
		if (delta !== 0) return delta;
	}
	return 0;
}

/**
 * Read the produced addon's actual glibc requirement with readelf. Returns null
 * when readelf is unavailable (non-Linux hosts cross-reading, containers
 * without binutils) — callers must then say the check was SKIPPED, never that
 * it passed.
 */
export async function inspectGlibcRequirement(addonPath: string): Promise<string | null | "unavailable"> {
	if (!Bun.which("readelf")) return "unavailable";
	const result = await $`readelf -W --dyn-syms ${addonPath}`.quiet().nothrow();
	if (result.exitCode !== 0) return "unavailable";
	return maxGlibcRequirement(result.stdout.toString("utf-8"));
}
