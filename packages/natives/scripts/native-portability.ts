import { $ } from "bun";

export const GLIBC_FLOOR = "2.17";

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
	| { kind: "explicitCross"; target: string }
	| { kind: "zigbuild"; target: string }
	| { kind: "hostOnly"; reason: string };

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

export async function inspectGlibcRequirement(addonPath: string): Promise<string | null | "unavailable"> {
	if (!Bun.which("readelf")) return "unavailable";
	const result = await $`readelf -W --dyn-syms ${addonPath}`.quiet().nothrow();
	if (result.exitCode !== 0) return "unavailable";
	return maxGlibcRequirement(result.stdout.toString("utf-8"));
}
