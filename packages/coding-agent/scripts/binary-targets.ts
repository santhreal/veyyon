/**
 * The one table of shipped binary targets.
 *
 * A target is a platform, an architecture, the Bun compile triple, the release
 * asset name, and whether the bundle is precompiled to bytecode. Both binary
 * builders read this table: `scripts/ci-release-build-binaries.ts` builds the
 * release assets from it, and `build-binary.ts` resolves a local `CROSS_TARGET`
 * against it.
 *
 * It is one table because two tables cost two releases. The Windows triple was
 * defined separately in each builder and kept aligned by hand, and every
 * correction had to be applied twice: `veyyon-windows-x64.exe` shipped a binary
 * that segfaulted at launch for v1.0.36 and again for v1.0.37. A single table
 * cannot disagree with itself, so the lockstep is structural rather than a
 * comment asking the next author to remember.
 *
 * This module holds data and one lookup. It imports nothing and runs nothing, so
 * reading a target never starts a build.
 */

/** One shipped binary: where it runs, how it is compiled, and what it is published as. */
export interface BinaryTarget {
	/** Stable id used by `RELEASE_TARGETS`, `--targets`, and `CROSS_TARGET`. */
	readonly id: string;
	readonly platform: string;
	readonly arch: string;
	readonly target: Bun.Build.CompileTarget;
	/** Release asset path, relative to the repository root. */
	readonly outfile: string;
	/**
	 * Precompile the bundle to Bun bytecode. Must be false for any target whose
	 * build runner OS differs from the target OS: cross-compiled bytecode
	 * executables segfault in JSC bytecode decoding at launch on the target OS
	 * (oven-sh/bun#18416, open as of 1.3.14 — veyyon's own published
	 * windows-x64 exe died in llint_entry on `--version`, v1.0.36 and v1.0.37,
	 * caught by release_github_verify_windows). Costs cold-start time only.
	 */
	readonly bytecode: boolean;
}

/** Every binary a release publishes, in the order the release build walks them. */
export const RELEASE_TARGETS: readonly BinaryTarget[] = [
	{
		id: "darwin-arm64",
		platform: "darwin",
		arch: "arm64",
		target: "bun-darwin-arm64",
		outfile: "packages/coding-agent/binaries/veyyon-darwin-arm64",
		bytecode: true, // built natively on macos-14
	},
	{
		id: "darwin-x64",
		platform: "darwin",
		arch: "x64",
		target: "bun-darwin-x64",
		outfile: "packages/coding-agent/binaries/veyyon-darwin-x64",
		bytecode: true, // built natively on macos-15-intel
	},
	{
		id: "linux-x64",
		platform: "linux",
		arch: "x64",
		target: "bun-linux-x64-baseline",
		outfile: "packages/coding-agent/binaries/veyyon-linux-x64",
		bytecode: true, // built natively on ubuntu-22.04
	},
	{
		id: "linux-arm64",
		platform: "linux",
		arch: "arm64",
		target: "bun-linux-arm64",
		outfile: "packages/coding-agent/binaries/veyyon-linux-arm64",
		bytecode: true, // built natively on ubuntu-24.04-arm
	},
	{
		id: "win32-x64",
		platform: "win32",
		arch: "x64",
		// Modern (AVX2) target. The earlier baseline->modern switch (blamed on
		// oven-sh/bun#32684/#32586) did NOT fix the launch segfault: v1.0.37's
		// modern exe crashed identically in llint_entry. The real cause is the
		// Linux->Windows cross-compile with bytecode (oven-sh/bun#18416), fixed
		// by bytecode: false below. Re-test baseline (wider pre-AVX2 CPU
		// support) once a bytecode-free release verifies green on Windows.
		target: "bun-windows-x64",
		outfile: "packages/coding-agent/binaries/veyyon-windows-x64.exe",
		bytecode: false, // cross-compiled on ubuntu-22.04 (oven-sh/bun#18416)
	},
];

/**
 * Extra `CROSS_TARGET` spellings a local build accepts, mapped to the target id.
 *
 * A local build is typed by hand, so `windows-x64` reaches for the Windows
 * target as readily as `win32-x64` does. An alias never carries its own triple:
 * it names a row in the table above.
 */
const CROSS_TARGET_ALIASES: Readonly<Record<string, string>> = {
	"windows-x64": "win32-x64",
};

/** The target with this id or accepted alias, or `undefined` when nothing matches. */
export function findBinaryTarget(idOrAlias: string): BinaryTarget | undefined {
	const id = CROSS_TARGET_ALIASES[idOrAlias] ?? idOrAlias;
	return RELEASE_TARGETS.find(target => target.id === id);
}
