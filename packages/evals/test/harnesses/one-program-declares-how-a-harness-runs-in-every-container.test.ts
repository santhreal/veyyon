/**
 * WHY: a harness that runs inside a task container had its contract written twice, once in
 * the TypeScript adapter that staged host files and once in the Python agent that uploaded
 * them and built the command. The two drifted: the omp adapter staged `omp`, `omp.env` and
 * `models.yml` while the pier agent refused to start unless `bun`, `cli.js`, `opencode-key`
 * and `omp-node-modules.tar.gz` were present, so no omp arm could run on any backend.
 *
 * The class this closes: one harness's container contract expressed once per backend or once
 * per language, free to diverge without a gate. The sweep enumerates the registry at run
 * time, so a harness that starts declaring a program joins it, and the pinned set turns red
 * until someone records a decision for it. Every declaration is validated by the TypeScript
 * builder and then by the Python executor that actually runs it, from the same staged bytes,
 * and both are shown to refuse the same five malformations.
 *
 * What it does not catch: whether the command the program declares is the right invocation
 * for that CLI, and anything about the container image the agent uploads into.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CONTAINER_PROGRAM_FILE,
	CONTAINER_PROGRAM_PLACEHOLDERS,
	type ContainerProgram,
	ContainerProgramError,
	containerProgramPath,
	programDirFor,
	validateContainerProgram,
} from "../../src/core/container-program";
import { listHarnesses } from "../../src/core/harness-registry";
import type { HarnessAdapter, Variant } from "../../src/core/types";
import { registerBuiltinHarnesses } from "../../src/harnesses/index";
import { agentsDir } from "../../src/paths";

registerBuiltinHarnesses();

/** Harnesses whose container run is one declaration. A new one turns the sweep red. */
const PROGRAM_HARNESSES: readonly string[] = ["omp"];

const MODEL = "opencode-go/deepseek-v4-flash";

/**
 * A host that has neither the harness CLI nor a vey binary still has to produce a program,
 * because staging copies whatever the arm names. The fake binary stands in for the CLI, and
 * the unreachable vey path keeps the optional catalog out so the staged bytes are the same
 * on every machine.
 */
let hostDir = "";
let options: Record<string, unknown> = {};

beforeAll(() => {
	hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "evals-program-host-"));
	const binary = path.join(hostDir, "omp");
	fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n");
	fs.chmodSync(binary, 0o755);
	options = { "omp-binary": binary, "omp-api-key": "test-key", "vey-binary": path.join(hostDir, "absent-vey") };
});

afterAll(() => {
	fs.rmSync(hostDir, { recursive: true, force: true });
});

function programHarnesses(): HarnessAdapter[] {
	return listHarnesses().filter(harness => harness.containerProgram !== undefined);
}

/** The harness's own declaration, refusing rather than skipping if it has none. */
function declaredProgram(harness: HarnessAdapter): ContainerProgram {
	const build = harness.containerProgram;
	if (!build) throw new Error(`harness ${harness.name} declares no container program`);
	return build.call(harness, { model: MODEL, options }).program;
}

function variantFor(harness: string, name: string): Variant {
	return { name, harness, configPath: null, promptVariantPath: null, model: MODEL, attachments: [] };
}

interface Mutation {
	readonly name: string;
	readonly mutate: (program: Record<string, unknown>) => void;
}

/** The first asset of a parsed program, as loose JSON the mutations can rewrite. */
function firstAsset(program: Record<string, unknown>): Record<string, unknown> {
	const assets = program.assets as Record<string, unknown>[];
	return assets[0];
}

/** The five malformations both validators are claimed to refuse, applied to real bytes. */
const MUTATIONS: readonly Mutation[] = [
	{
		name: "version",
		mutate: program => {
			program.version = 2;
		},
	},
	{
		name: "placeholder",
		mutate: program => {
			program.command = `${String(program.command)} {{secret}}`;
		},
	},
	{
		name: "relative_dest",
		mutate: program => {
			firstAsset(program).dest = "relative/omp";
		},
	},
	{
		name: "whitespace_file",
		mutate: program => {
			firstAsset(program).file = "om p";
		},
	},
	{
		name: "dialect",
		mutate: program => {
			program.usage = "nonesuch";
		},
	},
];

/**
 * Reads the staged program with the executor of record and reports what it parsed, plus the
 * refusal each mutation produced. One spawn covers both halves of the contract.
 */
const PYTHON_PROBE = `
import dataclasses
import json
import sys
from pathlib import Path

from common.container_program import load_program, parse_program

staged = Path(sys.argv[1])
mutations = json.loads(sys.argv[2])


def refusal(patched):
    try:
        parse_program(json.dumps(patched), "mutation")
    except ValueError as exc:
        return str(exc)
    return None


print(
    json.dumps(
        {
            "parsed": dataclasses.asdict(load_program(staged)),
            "refusals": {name: refusal(patched) for name, patched in mutations.items()},
        }
    )
)
`;

interface PythonReport {
	readonly parsed: {
		readonly harness: string;
		readonly container_dir: string;
		readonly command: string;
		readonly setup: readonly string[];
		readonly log_path: string;
		readonly env_file: string | null;
		readonly usage: string;
		readonly assets: readonly { readonly file: string; readonly dest: string; readonly mode: string | null }[];
		readonly sessions: { readonly sources: readonly string[]; readonly pattern: string };
		readonly allowed_domains: readonly string[];
	};
	readonly refusals: Readonly<Record<string, string | null>>;
}

function readWithPython(stagedPath: string, mutated: Record<string, unknown>): PythonReport {
	const stdout = execFileSync("python3", ["-c", PYTHON_PROBE, stagedPath, JSON.stringify(mutated)], {
		encoding: "utf8",
		env: { ...process.env, PYTHONPATH: agentsDir() },
	});
	return JSON.parse(stdout) as PythonReport;
}

describe("a harness that runs in a container declares that run once", () => {
	it("declares a program for exactly the harnesses pinned here", () => {
		expect(
			programHarnesses()
				.map(harness => harness.name)
				.sort(),
		).toEqual([...PROGRAM_HARNESSES]);
	});

	it("names, in every backend binding, the container directory its program uploads into", () => {
		for (const harness of programHarnesses()) {
			const declared = declaredProgram(harness);
			const bindings = Object.entries(harness.backends);
			expect(bindings.length).toBeGreaterThan(0);
			for (const [backend, binding] of bindings) {
				// A binding that points the agent at another directory is a trial that uploads
				// its assets where nothing reads them.
				expect({ backend, dir: binding?.containerAssetsDir }).toEqual({
					backend,
					dir: declared.containerDir,
				});
			}
		}
	});

	it("stages one arm's program at the same path, with the same bytes, for either staging context", async () => {
		for (const harness of programHarnesses()) {
			const armRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evals-program-arm-"));
			const systemRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evals-program-system-"));
			try {
				await harness.stageAssets?.({
					variant: variantFor(harness.name, "arm-one"),
					targetDir: armRoot,
					backend: "pier",
					options,
				});
				await harness.stageAssets?.({
					system: harness.name,
					assetsDir: systemRoot,
					outRoot: systemRoot,
					binarySha: "deadbeef",
					args: options,
					model: MODEL,
				});

				const armPath = containerProgramPath(programDirFor(armRoot, harness.name, "arm-one"));
				const systemPath = containerProgramPath(programDirFor(systemRoot, harness.name, harness.name));
				expect(fs.existsSync(armPath)).toBe(true);
				expect(fs.readFileSync(systemPath, "utf8")).toBe(fs.readFileSync(armPath, "utf8"));

				// The legacy comparison path hands the same file to the agent as a job-config
				// kwarg, so a second layout cannot appear there either.
				const kwargs = harness.buildJobConfigKwargs?.({
					system: harness.name,
					task: "task-1",
					repeat: 0,
					model: MODEL,
					assetsDir: systemRoot,
				});
				expect(kwargs).toEqual({ program_path: systemPath });

				const staged = JSON.parse(fs.readFileSync(armPath, "utf8")) as ContainerProgram;
				for (const asset of staged.assets) {
					const onDisk = path.join(path.dirname(armPath), asset.file);
					// An optional asset the host could not supply is the only absence allowed.
					expect(fs.existsSync(onDisk) || asset.optional === true).toBe(true);
				}
				expect(path.basename(armPath)).toBe(CONTAINER_PROGRAM_FILE);
			} finally {
				fs.rmSync(armRoot, { recursive: true, force: true });
				fs.rmSync(systemRoot, { recursive: true, force: true });
			}
		}
	});

	it("refuses, in both validators, every malformation the executor cannot run", async () => {
		for (const harness of programHarnesses()) {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "evals-program-refuse-"));
			try {
				await harness.stageAssets?.({
					variant: variantFor(harness.name, "arm-one"),
					targetDir: root,
					backend: "harbor",
					options,
				});
				const stagedPath = containerProgramPath(programDirFor(root, harness.name, "arm-one"));
				const bytes = fs.readFileSync(stagedPath, "utf8");

				const mutated: Record<string, unknown> = {};
				for (const { name, mutate } of MUTATIONS) {
					const patched = JSON.parse(bytes) as Record<string, unknown>;
					mutate(patched);
					mutated[name] = patched;
					expect(() => validateContainerProgram(patched as unknown as ContainerProgram)).toThrow(
						ContainerProgramError,
					);
				}

				const report = readWithPython(stagedPath, mutated);
				for (const { name } of MUTATIONS) {
					// A null here is the executor accepting bytes the builder refused, which is
					// how the two contracts drift apart again.
					expect({ name, refused: report.refusals[name] !== null }).toEqual({ name, refused: true });
				}

				// The same staged bytes, read by the agent that runs them.
				const declared = JSON.parse(bytes) as ContainerProgram;
				expect(report.parsed.harness).toBe(declared.harness);
				expect(report.parsed.container_dir).toBe(declared.containerDir);
				expect(report.parsed.command).toBe(declared.command);
				expect(report.parsed.setup).toEqual([...declared.setup]);
				expect(report.parsed.log_path).toBe(declared.logPath);
				expect(report.parsed.env_file).toBe(declared.envFile ?? null);
				expect(report.parsed.usage).toBe(declared.usage);
				expect(report.parsed.assets.map(asset => asset.dest)).toEqual(declared.assets.map(asset => asset.dest));
				expect(report.parsed.sessions.sources).toEqual([...declared.sessions.sources]);
				expect(report.parsed.sessions.pattern).toBe(declared.sessions.pattern);
				expect(report.parsed.allowed_domains).toEqual([...declared.allowedDomains]);

				// Only placeholders the executor substitutes may appear, and the instruction is
				// the one that must, or the arm runs the CLI with no task.
				const used = [...declared.command.matchAll(/\{\{([^}]*)\}\}/g)].map(match => match[1]);
				expect(used).toContain("instruction");
				for (const placeholder of used) {
					expect(CONTAINER_PROGRAM_PLACEHOLDERS).toContain(placeholder);
				}
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		}
	});
});
