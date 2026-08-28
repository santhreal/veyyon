#!/usr/bin/env bun

import { createRequire } from "node:module";
import * as path from "node:path";
import { findBinaryTarget } from "./binary-targets";
import { compileCodingAgent } from "./compile-binary";

const packageDir = path.join(import.meta.dir, "..");
const repoRoot = path.join(packageDir, "..", "..");

export interface CrossBuild {
	readonly id: string;
	readonly platform: string;
	readonly arch: string;
	readonly target: Bun.Build.CompileTarget;
}

export function resolveCrossBuild(value: string | undefined): CrossBuild | null {
	if (!value) return null;
	const target = findBinaryTarget(value);
	if (!target) throw new Error(`Unsupported CROSS_TARGET: ${value}`);
	return { id: value, platform: target.platform, arch: target.arch, target: target.target };
}

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
	await runCommand(
		["bun", "--cwd=../natives", "run", "gen:native"],
		crossBuild ? { ...Bun.env, TARGET_PLATFORM: crossBuild.platform, TARGET_ARCH: crossBuild.arch } : Bun.env,
	);
	await runCommand(["bun", "run", "gen:mupdf"]);
	await runCommand(["bun", "run", "gen:tool-views"]);
	await runCommand(["bun", "--cwd=../stats", "run", "gen:stats"]);
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
		await runCommand(["bun", "--cwd=../stats", "run", "gen:stats:reset"]);
		await runCommand(["bun", "--cwd=../natives", "run", "gen:native:reset"]);
	}
}

if (import.meta.main) await main();
