export interface BinaryTarget {
	readonly id: string;
	readonly platform: string;
	readonly arch: string;
	readonly target: Bun.Build.CompileTarget;
	readonly outfile: string;
	readonly bytecode: boolean;
}

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
		target: "bun-windows-x64",
		outfile: "packages/coding-agent/binaries/veyyon-windows-x64.exe",
		bytecode: false, // cross-compiled on ubuntu-22.04 (oven-sh/bun#18416)
	},
];

const CROSS_TARGET_ALIASES: Readonly<Record<string, string>> = {
	"windows-x64": "win32-x64",
};

export function findBinaryTarget(idOrAlias: string): BinaryTarget | undefined {
	const id = CROSS_TARGET_ALIASES[idOrAlias] ?? idOrAlias;
	return RELEASE_TARGETS.find(target => target.id === id);
}
