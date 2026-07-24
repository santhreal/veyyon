#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { COMPILED_EXTERNAL_DEPENDENCIES, compileCodingAgent } from "../packages/coding-agent/scripts/compile-binary";

export interface BinaryTarget {
	id: string;
	platform: string;
	arch: string;
	target: Bun.Build.CompileTarget;
	outfile: string;
	/**
	 * Precompile the bundle to Bun bytecode. Must be false for any target whose
	 * build runner OS differs from the target OS: cross-compiled bytecode
	 * executables segfault in JSC bytecode decoding at launch on the target OS
	 * (oven-sh/bun#18416, open as of 1.3.14 — veyyon's own published
	 * windows-x64 exe died in llint_entry on `--version`, v1.0.36 and v1.0.37,
	 * caught by release_github_verify_windows). Costs cold-start time only.
	 */
	bytecode: boolean;
}

const repoRoot = path.join(import.meta.dir, "..");
const binariesDir = path.join(repoRoot, "packages", "coding-agent", "binaries");
const entrypoint = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const transformersManifest: unknown = createRequire(import.meta.url)("@huggingface/transformers/package.json");
if (
	typeof transformersManifest !== "object" ||
	transformersManifest === null ||
	!("version" in transformersManifest) ||
	typeof transformersManifest.version !== "string"
) {
	throw new Error("@huggingface/transformers package manifest has no string version");
}
const transformersVersion = transformersManifest.version;
// Worker threads re-enter the binary's CLI entry module. Legacy Pi host
// modules are supplied by the in-memory compile plugin, so neither subsystem
// needs extra `--compile` entrypoints.
const isDryRun = process.argv.includes("--dry-run");
export const targets: BinaryTarget[] = [
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

function parseRequestedTargets(): Set<string> | null {
	const flagIndex = process.argv.indexOf("--targets");
	const flagValue =
		flagIndex >= 0
			? process.argv[flagIndex + 1]
			: (process.argv.find(arg => arg.startsWith("--targets="))?.split("=", 2)[1] ?? Bun.env.RELEASE_TARGETS);

	if (!flagValue) {
		return null;
	}

	return new Set(
		flagValue
			.split(",")
			.map(value => value.trim())
			.filter(Boolean),
	);
}

function shouldAdhocSignDarwinBinary(target: BinaryTarget): boolean {
	return target.platform === "darwin" && process.platform === "darwin";
}

async function runCommand(command: string[], cwd: string, env: NodeJS.ProcessEnv = Bun.env): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd,
		env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
	}
}

async function embedNative(target: BinaryTarget): Promise<void> {
	if (isDryRun) {
		console.log(`DRY RUN bun run gen:native [${target.platform}/${target.arch}]`);
		return;
	}

	await runCommand(["bun", "run", "gen:native"], repoRoot, {
		...Bun.env,
		TARGET_PLATFORM: target.platform,
		TARGET_ARCH: target.arch,
	});
}

async function buildBinary(target: BinaryTarget): Promise<void> {
	console.log(`Building ${target.outfile}...`);
	await embedNative(target);
	if (isDryRun) {
		console.log(
			`DRY RUN Bun.build target=${target.target} outfile=${target.outfile} external=${COMPILED_EXTERNAL_DEPENDENCIES.join(",")}`,
		);
		return;
	}

	await compileCodingAgent({
		repoRoot,
		entrypoint,
		outfile: path.join(repoRoot, target.outfile),
		transformersVersion,
		target: target.target,
		bytecode: target.bytecode,
		minifyIdentifiers: true,
		skipBuiltinCodesign: shouldAdhocSignDarwinBinary(target),
	});
	// Bun 1.3.12 emits a truncated Mach-O signature on darwin builds.
	if (shouldAdhocSignDarwinBinary(target)) {
		await runCommand(["codesign", "--force", "--sign", "-", path.join(repoRoot, target.outfile)], repoRoot);
	}
}

async function generateBundle(): Promise<void> {
	if (isDryRun) {
		console.log("DRY RUN bun --cwd=packages/coding-agent run gen:tool-views");
		console.log("DRY RUN bun run gen:mupdf");
		console.log("DRY RUN bun run gen:stats");
		return;
	}
	// Compiled binaries embed the tool-view renderers via `src/export/html/index.ts`
	// (`import ... "./n"`), which transitively imports the generated
	// `tool-views.generated.js`. Both artifacts are gitignored, so the release
	// build must regenerate them before Bun.build or the bundle fails with
	// `Could not resolve: "./tool-views.generated.js"`. build-binary.ts already
	// runs this; the CI release path was the only caller missing it.
	await runCommand(["bun", "--cwd=packages/coding-agent", "run", "gen:tool-views"], repoRoot);
	await runCommand(["bun", "run", "gen:mupdf"], repoRoot);
	// Compiled binaries ship no dashboard sources; without the embedded stats
	// archive `veyyon stats` 500s on every request (the empty placeholder
	// builds fine and only fails at runtime).
	await runCommand(["bun", "run", "gen:stats"], repoRoot);
}

async function resetArtifacts(): Promise<void> {
	if (isDryRun) {
		console.log("DRY RUN bun run gen:native:reset");
		console.log("DRY RUN bun run gen:mupdf:reset");
		console.log("DRY RUN bun run gen:stats:reset");
		return;
	}
	await runCommand(["bun", "run", "gen:native:reset"], repoRoot);
	await runCommand(["bun", "run", "gen:mupdf:reset"], repoRoot);
	await runCommand(["bun", "run", "gen:stats:reset"], repoRoot);
}

async function main(): Promise<void> {
	const requestedTargets = parseRequestedTargets();
	const selectedTargets = requestedTargets ? targets.filter(target => requestedTargets.has(target.id)) : targets;

	if (requestedTargets) {
		const unknownTargets = [...requestedTargets].filter(
			requestedTarget => !targets.some(target => target.id === requestedTarget),
		);
		if (unknownTargets.length > 0) {
			throw new Error(`Unknown release target(s): ${unknownTargets.join(", ")}`);
		}
	}

	if (selectedTargets.length === 0) {
		throw new Error("No release targets selected.");
	}

	await fs.mkdir(binariesDir, { recursive: true });
	// Generate inside the try so resetArtifacts() always restores the empty
	// checked-in placeholders, even if a generate or build step throws.
	try {
		await generateBundle();
		for (const target of selectedTargets) {
			await buildBinary(target);
		}
	} finally {
		await resetArtifacts();
	}
}

if (import.meta.main) {
	await main();
}
