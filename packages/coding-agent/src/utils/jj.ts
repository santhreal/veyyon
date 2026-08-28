import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which, readPipeText } from "@veyyon/utils";
import { LRUCache } from "lru-cache/raw";
import { adoptIntoPrimarySessionCpuBudget } from "../session/cpu-limit";
import * as git from "./git";

export interface JjCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface JjRepository {
	repoRoot: string;
	storeDir: string;
}

export interface DiffOptions {
	readonly files?: readonly string[];
	readonly nameOnly?: boolean;
	readonly signal?: AbortSignal;
}

interface CommandOptions {
	readonly signal?: AbortSignal;
}

export class JjCommandError extends Error {
	readonly args: readonly string[];
	readonly result: JjCommandResult;

	constructor(args: readonly string[], result: JjCommandResult) {
		super(formatCommandFailure(args, result));
		this.name = "JjCommandError";
		this.args = args.slice();
		this.result = result;
	}
}

function ensureAvailable(): void {
	if (!$which("jj")) {
		throw new Error("jj is not installed.");
	}
}

function formatCommandFailure(
	args: readonly string[],
	result: Pick<JjCommandResult, "exitCode" | "stdout" | "stderr">,
): string {
	const stderr = result.stderr.trim();
	if (stderr) return stderr;
	const stdout = result.stdout.trim();
	if (stdout) return stdout;
	return `jj ${args.join(" ")} failed with exit code ${result.exitCode}`;
}

async function jj(cwd: string, args: readonly string[], options: CommandOptions = {}): Promise<JjCommandResult> {
	const child = Bun.spawn(["jj", "--no-pager", "--color=never", ...args], {
		cwd,
		signal: options.signal,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	adoptIntoPrimarySessionCpuBudget(child.pid);

	if (!child.stdout || !child.stderr) {
		throw new Error("Failed to capture jj command output.");
	}

	const [stdout, stderr, exitCode] = await Promise.all([
		readPipeText(child.stdout),
		readPipeText(child.stderr),
		child.exited,
	]);

	return { exitCode: exitCode ?? 0, stdout, stderr };
}

async function runChecked(
	cwd: string,
	args: readonly string[],
	options: CommandOptions = {},
): Promise<JjCommandResult> {
	ensureAvailable();
	const result = await jj(cwd, args, options);
	if (result.exitCode !== 0) {
		throw new JjCommandError(args, result);
	}
	return result;
}

async function runText(cwd: string, args: readonly string[], options: CommandOptions = {}): Promise<string> {
	return (await runChecked(cwd, args, options)).stdout;
}

function buildDiffArgs(options: DiffOptions): string[] {
	const args = ["diff"];
	args.push(options.nameOnly ? "--name-only" : "--git");
	if (options.files?.length) args.push("--", ...options.files);
	return args;
}

interface WorkspaceRootCacheEntry {
	readonly root?: string;
}

const WORKSPACE_ROOT_CACHE_MAX_ENTRIES = 256;
const workspaceRootCache = new LRUCache<string, WorkspaceRootCacheEntry>({ max: WORKSPACE_ROOT_CACHE_MAX_ENTRIES });

async function hasJjWorkspaceMetadata(dir: string): Promise<boolean> {
	try {
		await fs.stat(path.join(dir, ".jj", "repo"));
		return true;
	} catch {
		return false;
	}
}

function parentOf(dir: string): string | undefined {
	const parent = path.dirname(dir);
	return parent === dir ? undefined : parent;
}

async function findWorkspaceRoot(cwd: string): Promise<string | undefined> {
	const key = path.resolve(cwd);
	if (workspaceRootCache.has(key)) return workspaceRootCache.get(key)?.root;

	for (let dir: string | undefined = key; dir; dir = parentOf(dir)) {
		if (await hasJjWorkspaceMetadata(dir)) {
			workspaceRootCache.set(key, { root: dir });
			return dir;
		}
	}

	workspaceRootCache.set(key, {});
	return undefined;
}

async function resolveRepoDir(root: string): Promise<string> {
	const jjDir = path.join(root, ".jj");
	const repoPath = path.join(jjDir, "repo");
	if ((await fs.stat(repoPath)).isFile()) {
		const target = (await fs.readFile(repoPath, "utf8")).trim();
		return path.resolve(jjDir, target);
	}
	return repoPath;
}

async function repositoryFromRoot(root: string): Promise<JjRepository> {
	return {
		repoRoot: root,
		storeDir: path.join(await resolveRepoDir(root), "store"),
	};
}

export const diff = Object.assign(
	async function diff(cwd: string, options: DiffOptions = {}): Promise<string> {
		return runText(cwd, buildDiffArgs(options), { signal: options.signal });
	},
	{
		async changedFiles(cwd: string, options: Pick<DiffOptions, "files" | "signal"> = {}): Promise<string[]> {
			return git.splitLines(await diff(cwd, { ...options, nameOnly: true }));
		},
	},
);

export const repo = {
	clearRootCache(): void {
		workspaceRootCache.clear();
	},

	async root(cwd: string): Promise<string | null> {
		return (await findWorkspaceRoot(cwd)) ?? null;
	},

	async resolve(cwd: string): Promise<JjRepository | null> {
		const root = await repo.root(cwd);
		return root ? await repositoryFromRoot(root) : null;
	},

	async is(cwd: string): Promise<boolean> {
		return (await repo.root(cwd)) !== null;
	},
};

export async function isPureJjRepo(cwd: string): Promise<boolean> {
	const jjRoot = await repo.root(cwd);
	if (jjRoot === null) return false;
	const gitRoot = await git.repo.root(cwd);
	if (gitRoot === null) return true;
	return isStrictDescendant(path.resolve(jjRoot), path.resolve(gitRoot));
}

function isStrictDescendant(child: string, ancestor: string): boolean {
	const rel = path.relative(ancestor, child);
	if (rel === "" || rel === ".") return false;
	if (rel.startsWith("..")) return false;
	return !path.isAbsolute(rel);
}
