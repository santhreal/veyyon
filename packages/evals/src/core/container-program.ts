/**
 * One declaration of how a harness runs inside a task container, and the staging that puts
 * it on disk.
 *
 * A harness that runs in a container is described twice unless something stops it: once
 * here, where the runner copies files into a staged assets directory, and once in the
 * Python agent that uploads them and builds the command. When the two lists drift the arm
 * does not run: the omp adapter staged `omp`, `omp.env` and `models.yml` while the pier
 * agent refused unless `bun`, `cli.js`, `opencode-key` and `omp-node-modules.tar.gz` were
 * present. A `ContainerProgram` is the single definition. TypeScript builds it, staging
 * writes it as `program.json` beside the files it names, and the generic Python agent that
 * both Pier and Harbor load executes it: `packages/evals/agents/common/container_program.py`.
 *
 * The asset names, the setup lines, the invocation, the log path and the session sources are
 * spelled once. A backend contributes the directory the program is staged in and the channel
 * that carries its path (a Pier job-config kwarg, a Harbor environment variable), nothing
 * more.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { sanitizeVariantName } from "./trial-naming";
import type { HarnessAdapter } from "./types";

/** Spec version the Python executor accepts. A bump refuses a stale staged program. */
export const CONTAINER_PROGRAM_VERSION = 1;

/** Filename the program is staged under, inside the directory holding its assets. */
export const CONTAINER_PROGRAM_FILE = "program.json";

/** Placeholders `command` may carry. Anything else is refused at build time. */
export const CONTAINER_PROGRAM_PLACEHOLDERS: readonly string[] = ["instruction", "model", "assets"];

/** Session-log formats the executor can read usage out of. */
export type SessionUsageDialect = "omp";

/** One file the runner staged on the host and the agent uploads into the container. */
export interface ProgramAsset {
	/** Path relative to the directory holding `program.json`. */
	readonly file: string;
	/** Absolute container destination. */
	readonly dest: string;
	/** Octal mode string applied after upload, for example `"0755"`. */
	readonly mode?: string;
	/** An absent host file is skipped instead of refused. */
	readonly optional?: boolean;
}

/** Where the agent's session transcripts land in the container, and what they are named. */
export interface ProgramSessions {
	readonly sources: readonly string[];
	readonly pattern: string;
}

/** The executable declaration: what to upload, what to run, where its output goes. */
export interface ContainerProgram {
	readonly version: typeof CONTAINER_PROGRAM_VERSION;
	readonly harness: string;
	readonly containerDir: string;
	readonly assets: readonly ProgramAsset[];
	readonly setup: readonly string[];
	readonly command: string;
	/**
	 * Container path of a `KEY=value` file sourced before the command. The provider key
	 * reaches the agent through this file so it never appears in argv, a process listing or
	 * the streamed log.
	 */
	readonly envFile?: string;
	readonly logPath: string;
	readonly sessions: ProgramSessions;
	readonly allowedDomains: readonly string[];
	readonly usage: SessionUsageDialect;
}

/** Where one staged file's bytes come from. */
export type ProgramFileSource = { readonly copy: string } | { readonly text: string };

/** One file staging writes into the program's directory. */
export interface ProgramFile {
	/** Must match a `ProgramAsset.file` the program declares. */
	readonly file: string;
	readonly source: ProgramFileSource;
	/** Host mode, independent of the container mode the program declares. */
	readonly mode?: number;
}

/** A program and the host bytes that satisfy it. */
export interface StagedProgram {
	readonly program: ContainerProgram;
	readonly files: readonly ProgramFile[];
}

/** What a harness needs to build its program: the arm's model and the run's flags. */
export interface ContainerProgramContext {
	readonly model: string;
	readonly options: Readonly<Record<string, unknown>>;
}

/** Refusal raised when a program, or the files offered for it, cannot be staged. */
export class ContainerProgramError extends Error {
	readonly program: string;

	constructor(harness: string, detail: string) {
		super(`container program for harness "${harness}": ${detail}`);
		this.name = "ContainerProgramError";
		this.program = harness;
	}
}

const HARNESS_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const OCTAL_MODE = /^0[0-7]{3}$/;
const PLACEHOLDER = /\{\{([^}]*)\}\}/g;

function refuseUnlessAbsolute(harness: string, label: string, value: string): void {
	if (value === "" || !path.posix.isAbsolute(value)) {
		throw new ContainerProgramError(
			harness,
			`${label} must be an absolute container path, got ${JSON.stringify(value)}`,
		);
	}
	if (/[\s\0]/.test(value)) {
		throw new ContainerProgramError(
			harness,
			`${label} must carry no whitespace or NUL byte, got ${JSON.stringify(value)}`,
		);
	}
}

/**
 * Throws the first problem the program carries. Every rule here is mirrored by
 * `load_program` in `agents/common/container_program.py`, which refuses the same shapes at
 * run time: a program this accepts is one the executor accepts.
 */
export function validateContainerProgram(program: ContainerProgram): void {
	const harness = program.harness;
	if (!HARNESS_NAME.test(harness)) {
		throw new ContainerProgramError(harness, `harness name must match ${HARNESS_NAME.source}`);
	}
	if (program.version !== CONTAINER_PROGRAM_VERSION) {
		throw new ContainerProgramError(harness, `version must be ${CONTAINER_PROGRAM_VERSION}, got ${program.version}`);
	}
	refuseUnlessAbsolute(harness, "containerDir", program.containerDir);
	refuseUnlessAbsolute(harness, "logPath", program.logPath);
	if (program.envFile !== undefined) refuseUnlessAbsolute(harness, "envFile", program.envFile);
	if (program.sessions.sources.length === 0) {
		throw new ContainerProgramError(harness, "sessions.sources must name at least one container directory");
	}
	for (const source of program.sessions.sources) {
		refuseUnlessAbsolute(harness, "sessions.sources entry", source);
	}
	if (program.sessions.pattern === "" || program.sessions.pattern.includes("/")) {
		throw new ContainerProgramError(
			harness,
			`sessions.pattern must be a filename glob, got ${JSON.stringify(program.sessions.pattern)}`,
		);
	}
	if (program.assets.length === 0) {
		throw new ContainerProgramError(harness, "assets must name at least one file to upload");
	}
	const seen = new Set<string>();
	for (const asset of program.assets) {
		if (
			asset.file === "" ||
			asset.file.startsWith("/") ||
			asset.file.split("/").includes("..") ||
			/[\s\0]/.test(asset.file)
		) {
			throw new ContainerProgramError(
				harness,
				`asset file must be relative to the program directory, stay inside it, and carry no whitespace or NUL byte, got ${JSON.stringify(asset.file)}`,
			);
		}
		if (seen.has(asset.file)) {
			throw new ContainerProgramError(harness, `asset file ${JSON.stringify(asset.file)} is declared twice`);
		}
		seen.add(asset.file);
		refuseUnlessAbsolute(harness, `asset ${JSON.stringify(asset.file)} dest`, asset.dest);
		if (asset.mode !== undefined && !OCTAL_MODE.test(asset.mode)) {
			throw new ContainerProgramError(
				harness,
				`asset ${JSON.stringify(asset.file)} mode must be an octal string like "0755", got ${JSON.stringify(asset.mode)}`,
			);
		}
	}
	if (program.command.trim() === "") {
		throw new ContainerProgramError(harness, "command must not be empty");
	}
	for (const match of program.command.matchAll(PLACEHOLDER)) {
		const name = match[1] ?? "";
		if (!CONTAINER_PROGRAM_PLACEHOLDERS.includes(name)) {
			throw new ContainerProgramError(
				harness,
				`command carries unknown placeholder {{${name}}}; the executor substitutes ${CONTAINER_PROGRAM_PLACEHOLDERS.map(p => `{{${p}}}`).join(", ")}`,
			);
		}
	}
	if (program.usage !== "omp") {
		throw new ContainerProgramError(harness, `usage dialect ${JSON.stringify(program.usage)} has no reader`);
	}
}

/** Absolute path of the staged program inside `dir`. */
export function containerProgramPath(dir: string): string {
	return path.join(dir, CONTAINER_PROGRAM_FILE);
}

/**
 * Writes the program and every file it names into `dir`, and returns the program's path.
 *
 * A declared asset with no source is a refusal unless the program marks it optional, so a
 * staged directory never satisfies its own manifest by accident. A source that names a file
 * the host does not hold is a refusal too: the alternative is a trial that starts, uploads
 * nothing and fails inside the container.
 */
export function stageContainerProgram(dir: string, staged: StagedProgram): string {
	const { program, files } = staged;
	validateContainerProgram(program);

	const offered = new Map<string, ProgramFile>();
	for (const file of files) {
		if (offered.has(file.file)) {
			throw new ContainerProgramError(program.harness, `staged file ${JSON.stringify(file.file)} is offered twice`);
		}
		offered.set(file.file, file);
	}
	for (const file of files) {
		if (!program.assets.some(asset => asset.file === file.file)) {
			throw new ContainerProgramError(
				program.harness,
				`staged file ${JSON.stringify(file.file)} is not an asset the program declares`,
			);
		}
	}

	fs.mkdirSync(dir, { recursive: true });
	for (const asset of program.assets) {
		const file = offered.get(asset.file);
		if (!file) {
			if (asset.optional) continue;
			throw new ContainerProgramError(
				program.harness,
				`asset ${JSON.stringify(asset.file)} is required and nothing was staged for it`,
			);
		}
		const dest = path.join(dir, asset.file);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		if ("copy" in file.source) {
			if (!fs.existsSync(file.source.copy)) {
				throw new ContainerProgramError(
					program.harness,
					`asset ${JSON.stringify(asset.file)} names a host file that does not exist: ${file.source.copy}`,
				);
			}
			fs.copyFileSync(file.source.copy, dest);
		} else {
			fs.writeFileSync(dest, file.source.text);
		}
		if (file.mode !== undefined) fs.chmodSync(dest, file.mode);
	}

	const programPath = containerProgramPath(dir);
	fs.writeFileSync(programPath, `${JSON.stringify(program, null, "\t")}\n`);
	return programPath;
}

/**
 * Stages the harness's own program into `dir` and returns the staged program's path.
 *
 * Every caller that needs a program on disk goes through here: the Pier backend, the Harbor
 * backend and the DeepSWE comparison executor. A harness with no program declaration is a
 * refusal naming it, because the alternative is a trial that launches an agent with an empty
 * assets directory.
 */
export function stageHarnessProgram(harness: HarnessAdapter, dir: string, context: ContainerProgramContext): string {
	if (!harness.containerProgram) {
		throw new ContainerProgramError(harness.name, "harness declares no container program to stage");
	}
	return stageContainerProgram(dir, harness.containerProgram(context));
}

/**
 * The directory one arm's program is staged in, under a backend's assets root.
 *
 * Every backend files a program the same way, so a reader of a run directory finds an arm's
 * program in one place and a second backend cannot invent a second layout.
 */
export function programDirFor(root: string, harness: string, variantName: string): string {
	return path.join(root, "programs", harness, sanitizeVariantName(variantName));
}
