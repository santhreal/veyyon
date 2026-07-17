#!/usr/bin/env bun

import { createRequire } from "node:module";
import * as path from "node:path";
import { compileCodingAgent } from "./compile-binary";

const packageDir = path.join(import.meta.dir, "..");
const repoRoot = path.join(packageDir, "..", "..");

/** Binary cross-compilation settings selected by `CROSS_TARGET`. */
export interface CrossBuild {
	readonly id: string;
	readonly platform: string;
	readonly arch: string;
	readonly target: Bun.Build.CompileTarget;
}

/** Resolves a CROSS_TARGET value to the Bun compile target used by local binary builds. */
export function resolveCrossBuild(value: string | undefined): CrossBuild | null {
	switch (value) {
		case undefined:
		case "":
			return null;
		case "darwin-arm64":
			return { id: value, platform: "darwin", arch: "arm64", target: "bun-darwin-arm64" };
		case "darwin-x64":
			return { id: value, platform: "darwin", arch: "x64", target: "bun-darwin-x64" };
		case "linux-arm64":
			return { id: value, platform: "linux", arch: "arm64", target: "bun-linux-arm64" };
		case "linux-x64":
			return { id: value, platform: "linux", arch: "x64", target: "bun-linux-x64-baseline" };
		case "win32-x64":
		case "windows-x64":
			return { id: value, platform: "win32", arch: "x64", target: "bun-windows-x64-baseline" };
		default:
			throw new Error(`Unsupported CROSS_TARGET: ${value}`);
	}
}

// Transformers.js is an optional, native-heavy dependency that is never bundled
// into the binary; the tiny-model worker `bun install`s it into a runtime cache
// on first use. The `catalog:` spec cannot be resolved from inside the compiled
// bunfs (issue #1763), so embed the concrete installed version here for the
// worker to pin its runtime install against.
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

function shouldAdhocSignDarwinBinary(crossBuild: CrossBuild | null): boolean {
	return process.platform === "darwin" && !crossBuild;
}

async function runCommand(
	command: string[],
	env: NodeJS.ProcessEnv = Bun.env,
	cwd: string = packageDir,
): Promise<void> {
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

async function main(): Promise<void> {
	const crossBuild = resolveCrossBuild(Bun.env.CROSS_TARGET);
	const outName = crossBuild ? `vey-${crossBuild.id}` : "vey";
	const outputPath = path.join(packageDir, "dist", outName);
	// tool-views.generated.js is a build artifact (gitignored); regenerate it from
	// src/export/html/tool-render/ before bundling the export subpath.
	await runCommand(
		["bun", "--cwd=../natives", "run", "gen:native"],
		crossBuild ? { ...Bun.env, TARGET_PLATFORM: crossBuild.platform, TARGET_ARCH: crossBuild.arch } : Bun.env,
	);
	await runCommand(["bun", "run", "gen:mupdf"]);
	await runCommand(["bun", "run", "gen:tool-views"]);
	try {
		await compileCodingAgent({
			repoRoot,
			entrypoint: path.join(packageDir, "src", "cli.ts"),
			outfile: outputPath,
			transformersVersion,
			target: crossBuild?.target,
			skipBuiltinCodesign: shouldAdhocSignDarwinBinary(crossBuild),
		});

		if (shouldAdhocSignDarwinBinary(crossBuild)) {
			await runCommand(["codesign", "--force", "--sign", "-", outputPath]);
		}
	} finally {
		await runCommand(["bun", "run", "gen:mupdf:reset"]);
		await runCommand(["bun", "--cwd=../natives", "run", "gen:native:reset"]);
	}
}

if (import.meta.main) await main();
