/**
 * Locks the linux-gnu portability contract for locally built native addons.
 *
 * Why this suite exists: a local `gen:native` on Ubuntu 24.04 linked glibc 2.39
 * into `veyyon_natives.linux-x64-*.node`, so a locally built `dist/vey` LOOKED
 * distributable but hard-failed (`GLIBC_2.39 not found`) in every container or
 * distro older than the build host — while CI's zigbuild path pins glibc 2.17.
 * These tests prove the routing decision (zigbuild when the toolchain exists,
 * loud host-only otherwise, never a silent host build posing as portable), the
 * readelf floor parsing the post-build check runs on real ELF output, and that
 * ci.yml's GLIBC_FLOOR mirror cannot drift from the single owner.
 */
import * as path from "node:path";
import { describe, expect, it } from "bun:test";
import {
	exceedsGlibcFloor,
	GLIBC_FLOOR,
	maxGlibcRequirement,
	pinnedLinuxGnuTriple,
	planLinuxNativeRoute,
} from "../scripts/native-portability";

const repoRoot = path.join(import.meta.dir, "../../..");

describe("planLinuxNativeRoute — how a native build chooses its glibc story", () => {
	const base = {
		crossTarget: undefined,
		platform: "linux",
		arch: "x64",
		zigAvailable: true,
		cargoZigbuildAvailable: true,
		hostOnlyOverride: false,
	};

	it("pins the release glibc floor via zigbuild when the toolchain is present", () => {
		// The core fix: a plain local `gen:native` with zig installed must build
		// the SAME portable artifact CI ships, not a host-glibc one.
		expect(planLinuxNativeRoute(base)).toEqual({ kind: "zigbuild", target: `x86_64-unknown-linux-gnu.${GLIBC_FLOOR}` });
		expect(planLinuxNativeRoute({ ...base, arch: "arm64" })).toEqual({
			kind: "zigbuild",
			target: `aarch64-unknown-linux-gnu.${GLIBC_FLOOR}`,
		});
	});

	it("goes host-only with the reason recorded when zig or cargo-zigbuild is missing", () => {
		// Host-only is allowed but NEVER silent: the reason feeds the loud
		// post-build warning that names the real floor.
		expect(planLinuxNativeRoute({ ...base, zigAvailable: false })).toEqual({
			kind: "hostOnly",
			reason: "zig is not installed",
		});
		expect(planLinuxNativeRoute({ ...base, cargoZigbuildAvailable: false })).toEqual({
			kind: "hostOnly",
			reason: "cargo-zigbuild is not installed",
		});
	});

	it("honors the explicit VEYYON_NATIVE_HOST_ONLY opt-out even with zig present", () => {
		expect(planLinuxNativeRoute({ ...base, hostOnlyOverride: true })).toEqual({
			kind: "hostOnly",
			reason: "VEYYON_NATIVE_HOST_ONLY=1 requested a host-glibc build",
		});
	});

	it("defers to an explicit CROSS_TARGET verbatim (CI owns its own pinning)", () => {
		expect(planLinuxNativeRoute({ ...base, crossTarget: "x86_64-unknown-linux-gnu.2.17" })).toEqual({
			kind: "explicitCross",
			target: "x86_64-unknown-linux-gnu.2.17",
		});
	});

	it("stays out of the way on non-linux platforms and unsupported arches", () => {
		expect(planLinuxNativeRoute({ ...base, platform: "darwin" })).toBeNull();
		expect(planLinuxNativeRoute({ ...base, platform: "win32" })).toBeNull();
		expect(planLinuxNativeRoute({ ...base, arch: "riscv64" })).toBeNull();
	});

	it("rejects arches with no pinned triple instead of inventing one", () => {
		expect(() => pinnedLinuxGnuTriple("riscv64")).toThrow(/No pinned linux-gnu triple/);
	});
});

describe("maxGlibcRequirement — parsing the addon's real floor from readelf", () => {
	it("finds the highest versioned glibc symbol across the table", () => {
		// Shape taken from real `readelf -W --dyn-syms` output.
		const output = [
			"     3: 0000000000000000     0 FUNC    GLOBAL DEFAULT  UND memcpy@GLIBC_2.14 (3)",
			"     9: 0000000000000000     0 FUNC    GLOBAL DEFAULT  UND pthread_create@GLIBC_2.34 (5)",
			"    12: 0000000000000000     0 FUNC    GLOBAL DEFAULT  UND malloc@GLIBC_2.2.5 (2)",
		].join("\n");
		expect(maxGlibcRequirement(output)).toBe("2.34");
	});

	it("compares versions numerically, not lexically (2.9 < 2.17)", () => {
		// The classic trap: string comparison calls 2.9 newer than 2.17.
		const output = ["a@GLIBC_2.9 (1)", "b@GLIBC_2.17 (2)"].join("\n");
		expect(maxGlibcRequirement(output)).toBe("2.17");
	});

	it("returns null when no versioned glibc symbols exist (musl/static)", () => {
		expect(maxGlibcRequirement("     1: 0000000000000000 0 FUNC GLOBAL DEFAULT UND free")).toBeNull();
	});
});

describe("exceedsGlibcFloor — the enforcement comparison", () => {
	it("flags a host-glibc addon against the release floor", () => {
		// The exact bug this suite locks out: 2.39 (Ubuntu 24.04 host) vs 2.17.
		expect(exceedsGlibcFloor("2.39", GLIBC_FLOOR)).toBe(true);
	});

	it("accepts requirements at or below the floor, comparing numerically", () => {
		expect(exceedsGlibcFloor("2.17", GLIBC_FLOOR)).toBe(false);
		expect(exceedsGlibcFloor("2.2.5", GLIBC_FLOOR)).toBe(false);
		expect(exceedsGlibcFloor("2.9", GLIBC_FLOOR)).toBe(false);
	});
});

describe("GLIBC_FLOOR single ownership", () => {
	it("matches ci.yml's GLIBC_FLOOR env mirror (a workflow cannot import TS)", async () => {
		// ONE PLACE: native-portability.ts owns the value; this assertion is the
		// only thing keeping the ci.yml mirror honest.
		const ciYml = await Bun.file(path.join(repoRoot, ".github/workflows/ci.yml")).text();
		const match = /GLIBC_FLOOR:\s*"([0-9.]+)"/.exec(ciYml);
		expect(match?.[1]).toBe(GLIBC_FLOOR);
	});
});
