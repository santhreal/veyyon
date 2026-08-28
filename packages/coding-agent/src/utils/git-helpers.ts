export interface GitCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface GitRepository {
	commonDir: string;
	gitDir: string;
	gitEntryPath: string;
	headPath: string;
	repoRoot: string;
	isReftable?: boolean;
}

export interface GitStatusSummary {
	staged: number;
	unstaged: number;
	untracked: number;
	truncated: boolean;
}

export type HunkSelection = {
	path: string;
	hunks: { type: "all" } | { type: "indices"; indices: number[] } | { type: "lines"; start: number; end: number };
};

export interface StageHunksOptions {
	readonly diffCached?: boolean;
	readonly rawDiff?: string;
	readonly signal?: AbortSignal;
}
export interface HunkSelectionValidationError {
	readonly path: string;
	readonly message: string;
}

export interface DiffOptions {
	readonly allowFailure?: boolean;
	readonly base?: string;
	readonly binary?: boolean;
	readonly cached?: boolean;
	readonly env?: Record<string, string | undefined>;
	readonly files?: readonly string[];
	readonly head?: string;
	readonly nameOnly?: boolean;
	readonly noIndex?: { left: string; right: string };
	readonly numstat?: boolean;
	readonly signal?: AbortSignal;
	readonly stat?: boolean;
}

export interface StatusOptions {
	readonly pathspecs?: readonly string[];
	readonly porcelainV1?: boolean;
	readonly signal?: AbortSignal;
	readonly untrackedFiles?: "all" | "no" | "normal";
	readonly z?: boolean;
}

export interface CommitAuthor {
	readonly date?: string;
	readonly email: string;
	readonly name: string;
}

export interface CommitDetails {
	readonly author: CommitAuthor;
	readonly message: string;
}

export interface CommitOptions {
	readonly allowEmpty?: boolean;
	readonly author?: CommitAuthor;
	readonly files?: readonly string[];
	readonly signal?: AbortSignal;
}

export interface PushOptions {
	readonly forceWithLease?: boolean;
	readonly refspec?: string;
	readonly remote?: string;
	readonly signal?: AbortSignal;
}

export interface PatchOptions {
	readonly cached?: boolean;
	readonly check?: boolean;
	readonly env?: Record<string, string | undefined>;
	readonly reverse?: boolean;
	readonly threeWay?: boolean;
	readonly signal?: AbortSignal;
}

export interface RestoreOptions {
	readonly files?: readonly string[];
	readonly signal?: AbortSignal;
	readonly source?: string;
	readonly staged?: boolean;
	readonly worktree?: boolean;
}

export interface FetchOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export interface CloneOptions {
	readonly ref?: string;
	readonly sha?: string;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export interface GitHeadBase extends GitRepository {
	headContent: string;
}

export interface GitRefHead extends GitHeadBase {
	branchName: string | null;
	commit: string | null;
	kind: "ref";
	ref: string;
}

export interface GitDetachedHead extends GitHeadBase {
	commit: string | null;
	kind: "detached";
}

export type GitHeadState = GitRefHead | GitDetachedHead;

export type GitOperationKind = "am" | "bisect" | "cherry-pick" | "merge" | "rebase" | "revert";

export interface GitInProgressOperation {
	kind: GitOperationKind;
	branch: string | null;
}

export interface GitWorktreeEntry {
	branch?: string;
	detached: boolean;
	head?: string;
	path: string;
}

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isAbortError } from "@veyyon/utils/abortable";
import { hasFsCode, isEisdir, isEnoent, isEnotdir } from "@veyyon/utils/fs-error";
import { Snowflake } from "@veyyon/utils/snowflake";
import { $which } from "@veyyon/utils/which";
import type { Subprocess } from "bun";
import { adoptIntoPrimarySessionCpuBudget } from "../session/cpu-limit";
import { throwIfAborted } from "../tools/tool-errors";

import { repo } from "./git";

export class GitCommandError extends Error {
	readonly args: readonly string[];
	readonly result: GitCommandResult;

	constructor(args: readonly string[], result: GitCommandResult) {
		super(formatCommandFailure(args, result));
		this.name = "GitCommandError";
		this.args = args.slice();
		this.result = result;
	}
}

export const NO_OPTIONAL_LOCKS = "--no-optional-locks";
export const HEAD_REF_PREFIX = "ref:";
export const LOCAL_BRANCH_PREFIX = "refs/heads/";
export const DEFAULT_BRANCH_REFS = ["refs/remotes/origin/HEAD", "refs/remotes/upstream/HEAD"] as const;
export const SHORT_LIVED_GIT_CONFIG: readonly (readonly [key: string, value: string])[] = [
	["core.fsmonitor", "false"],
	["core.untrackedCache", "false"],
];
export const AMBIENT_GIT_ENV = {
	GIT_DIR: undefined,
	GIT_COMMON_DIR: undefined,
	GIT_WORK_TREE: undefined,
	GIT_INDEX_FILE: undefined,
	GIT_OBJECT_DIRECTORY: undefined,
	GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
} satisfies Record<string, undefined>;

export const GIT_NON_INTERACTIVE_ENV = {
	GIT_ASKPASS: "true",
	GIT_EDITOR: "true",
	GIT_TERMINAL_PROMPT: "0",
	SSH_ASKPASS: "/usr/bin/false",
} satisfies Record<string, string>;
export const GH_NON_INTERACTIVE_ENV = {
	...GIT_NON_INTERACTIVE_ENV,
	GH_PROMPT_DISABLED: "1",
} satisfies Record<string, string>;

export const GIT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
export const GIT_NETWORK_TIMEOUT_MS = 30 * 60 * 1000;
export const GIT_COMMAND_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;

export const GIT_COMMAND_TIMEOUT_EXIT_CODE = 124;
export const GIT_OUTPUT_TRUNCATED_NOTICE = "[git subprocess output truncated after 8 MiB]";
export const GIT_OUTPUT_TRUNCATED_MARKER = `\n${GIT_OUTPUT_TRUNCATED_NOTICE}\n`;
export const GIT_COMMAND_TERMINATE_GRACE_MS = 5_000;

export type CommandName = "git" | "gh";

export function resolveTimeoutMs(timeoutMs: number | undefined, fallback: number = GIT_COMMAND_TIMEOUT_MS): number {
	if (timeoutMs === undefined) return fallback;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return fallback;
	return Math.trunc(timeoutMs);
}

export function resolveOutputLimit(maxOutputBytes: number | undefined): number {
	if (maxOutputBytes === undefined) return GIT_COMMAND_OUTPUT_LIMIT_BYTES;
	if (!Number.isFinite(maxOutputBytes) || maxOutputBytes < 0) return GIT_COMMAND_OUTPUT_LIMIT_BYTES;
	return Math.trunc(maxOutputBytes);
}

export function formatCommandLabel(command: CommandName, args: readonly string[]): string {
	return `${command} ${args.join(" ")}`.trim();
}

export async function waitForChildExit(child: Subprocess, timeoutMs: number): Promise<boolean> {
	if (timeoutMs <= 0) return false;
	const timeout = Promise.withResolvers<false>();
	const timer = setTimeout(() => timeout.resolve(false), timeoutMs);
	timer.unref?.();
	try {
		return await Promise.race([
			child.exited.then(
				() => true,
				() => true,
			),
			timeout.promise,
		]);
	} finally {
		clearTimeout(timer);
	}
}

export async function terminateTimedOutChild(child: Subprocess): Promise<void> {
	child.kill("SIGTERM");
	if (await waitForChildExit(child, GIT_COMMAND_TERMINATE_GRACE_MS)) return;
	child.kill("SIGKILL");
	await waitForChildExit(child, GIT_COMMAND_TERMINATE_GRACE_MS);
}

export async function waitForExitWithTimeout(
	child: Subprocess,
	commandLabel: string,
	timeoutMs: number,
): Promise<{ exitCode: number | null; timedOut: false } | { timedOut: true; stderr: string }> {
	if (timeoutMs === 0) {
		await terminateTimedOutChild(child);
		return { timedOut: true, stderr: `${commandLabel} timed out after 0ms` };
	}
	const timeout = Promise.withResolvers<"timeout">();
	const timer = setTimeout(() => timeout.resolve("timeout"), timeoutMs);
	timer.unref?.();
	try {
		const result = await Promise.race([
			child.exited.then(exitCode => ({ kind: "exit" as const, exitCode })),
			timeout.promise.then(() => ({ kind: "timeout" as const })),
		]);
		if (result.kind === "exit") {
			return { timedOut: false, exitCode: result.exitCode };
		}
		await terminateTimedOutChild(child);
		return { timedOut: true, stderr: `${commandLabel} timed out after ${timeoutMs}ms` };
	} finally {
		clearTimeout(timer);
	}
}

export async function readCappedText(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	let remaining = maxBytes;
	let truncated = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!truncated && value.length <= remaining) {
				chunks.push(decoder.decode(value, { stream: true }));
				remaining -= value.length;
				continue;
			}
			if (!truncated && remaining > 0) {
				chunks.push(decoder.decode(value.subarray(0, remaining), { stream: true }));
				remaining = 0;
			}
			truncated = true;
		}
		chunks.push(decoder.decode());
		if (truncated) chunks.push(GIT_OUTPUT_TRUNCATED_MARKER);
		return chunks.join("");
	} finally {
		reader.releaseLock();
	}
}

export async function cancelOutput(stream: ReadableStream<Uint8Array>): Promise<void> {
	try {
		await stream.cancel();
	} catch {}
}

export async function collectSubprocessResult(
	command: CommandName,
	args: readonly string[],
	child: Subprocess,
	options: Pick<CommandOptions, "maxOutputBytes" | "timeoutMs"> = {},
): Promise<GitCommandResult> {
	const stdoutStream = child.stdout;
	const stderrStream = child.stderr;
	if (!(stdoutStream instanceof ReadableStream) || !(stderrStream instanceof ReadableStream)) {
		throw new Error(`Failed to capture ${command} command output.`);
	}
	const maxOutputBytes = resolveOutputLimit(options.maxOutputBytes);
	const stdoutPromise = readCappedText(stdoutStream, maxOutputBytes);
	const stderrPromise = readCappedText(stderrStream, maxOutputBytes);
	const exit = await waitForExitWithTimeout(
		child,
		formatCommandLabel(command, args),
		resolveTimeoutMs(options.timeoutMs),
	);
	if (exit.timedOut) {
		void stdoutPromise.catch(() => undefined);
		void stderrPromise.catch(() => undefined);
		await Promise.all([cancelOutput(stdoutStream), cancelOutput(stderrStream)]);
		return { exitCode: GIT_COMMAND_TIMEOUT_EXIT_CODE, stdout: "", stderr: exit.stderr };
	}
	const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
	return { exitCode: exit.exitCode ?? 0, stdout, stderr };
}

export interface CommandOptions {
	readonly env?: Record<string, string | undefined>;
	readonly maxOutputBytes?: number;
	readonly readOnly?: boolean;
	readonly signal?: AbortSignal;
	readonly stdin?: string | Uint8Array | ArrayBuffer | SharedArrayBuffer;
	readonly timeoutMs?: number;
}

export function normalizeStdin(input: CommandOptions["stdin"]): "ignore" | Uint8Array {
	if (input === undefined) return "ignore";
	if (typeof input === "string") return new TextEncoder().encode(input);
	if (input instanceof Uint8Array) return input;
	return new Uint8Array(input);
}

export function buildGitEnv(overrides?: Record<string, string | undefined>): Record<string, string | undefined> {
	return {
		...process.env,
		GIT_OPTIONAL_LOCKS: "0",
		...AMBIENT_GIT_ENV,
		...overrides,
		...GIT_NON_INTERACTIVE_ENV,
	};
}

export function ensureAvailable(): void {
	if (!$which("git")) {
		throw new Error("git is not installed.");
	}
}

export function formatCommandFailure(
	args: readonly string[],
	result: Pick<GitCommandResult, "exitCode" | "stdout" | "stderr">,
): string {
	const stderr = result.stderr.trim();
	if (stderr) return stderr;
	const stdout = result.stdout.trim();
	if (stdout) return stdout;
	return `git ${args.join(" ")} failed with exit code ${result.exitCode}`;
}

export async function git(
	cwd: string,
	args: readonly string[],
	options: CommandOptions = {},
): Promise<GitCommandResult> {
	const commandArgs = withShortLivedGitConfig(options.readOnly ? withNoOptionalLocks(args) : args.slice());
	const child = Bun.spawn(["git", ...commandArgs], {
		cwd,
		env: buildGitEnv(options.env),
		signal: options.signal,
		stdin: normalizeStdin(options.stdin),
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	adoptIntoPrimarySessionCpuBudget(child.pid);

	return await collectSubprocessResult("git", commandArgs, child, options);
}

export function withNoOptionalLocks(args: readonly string[]): string[] {
	if (args.includes(NO_OPTIONAL_LOCKS)) return args.slice();
	return [NO_OPTIONAL_LOCKS].concat(args);
}

export function withShortLivedGitConfig(args: readonly string[]): string[] {
	const prefix: string[] = [];
	for (const [key, value] of SHORT_LIVED_GIT_CONFIG) {
		if (hasGitConfig(args, key, value)) continue;
		prefix.push("-c", `${key}=${value}`);
	}
	return prefix.concat(args);
}

export function hasGitConfig(args: readonly string[], key: string, value: string): boolean {
	const expected = `${key}=${value}`;
	for (let index = 0; index < args.length - 1; index += 1) {
		if (args[index] === "-c" && args[index + 1] === expected) {
			return true;
		}
	}
	return false;
}

export async function runChecked(
	cwd: string,
	args: readonly string[],
	options: CommandOptions = {},
): Promise<GitCommandResult> {
	ensureAvailable();
	const result = await git(cwd, args, options);
	if (result.exitCode !== 0) {
		throw new GitCommandError(args, result);
	}
	return result;
}

export async function runEffect(cwd: string, args: readonly string[], options: CommandOptions = {}): Promise<void> {
	await runChecked(cwd, args, options);
}

export async function runText(cwd: string, args: readonly string[], options: CommandOptions = {}): Promise<string> {
	return (await runChecked(cwd, args, options)).stdout;
}

export async function tryText(
	cwd: string,
	args: readonly string[],
	options: CommandOptions = {},
): Promise<string | undefined> {
	ensureAvailable();
	const result = await git(cwd, args, options);
	if (result.exitCode !== 0) return undefined;
	return result.stdout;
}

export const repoWriteChain = new Map<string, Promise<unknown>>();

export async function withRepoLock<T>(cwd: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	const key = (await repo.primaryRoot(cwd, signal)) ?? cwd;
	const prior = repoWriteChain.get(key);
	const run = (async () => {
		if (prior) {
			try {
				await prior;
			} catch {}
		}
		throwIfAborted(signal);
		return fn();
	})();
	repoWriteChain.set(key, run);
	try {
		return await run;
	} finally {
		if (repoWriteChain.get(key) === run) repoWriteChain.delete(key);
	}
}

export function splitLines(text: string): string[] {
	return text
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
}

export function trimScalar(text: string | undefined): string | undefined {
	const trimmed = text?.trim();
	return trimmed || undefined;
}

export function buildDiffArgs(options: DiffOptions): string[] {
	const args = ["diff"];
	if (options.binary) args.push("--binary");
	if (options.cached) args.push("--cached");
	if (options.nameOnly) args.push("--name-only");
	if (options.stat) args.push("--stat");
	if (options.numstat) args.push("--numstat");
	if (options.noIndex) {
		args.push("--no-index", options.noIndex.left, options.noIndex.right);
		return args;
	}
	if (options.base) {
		args.push(options.base);
		if (options.head) args.push(options.head);
	}
	if (options.files?.length) args.push("--", ...options.files);
	return args;
}

export function buildApplyArgs(patchPath: string, options: PatchOptions): string[] {
	const args = ["apply"];
	if (options.check) args.push("--check");
	if (options.cached) args.push("--cached");
	if (options.reverse) args.push("--reverse");
	if (options.threeWay) args.push("--3way");
	args.push("--binary", patchPath);
	return args;
}

export async function writeTempPatch(content: string): Promise<string> {
	const tempPath = path.join(os.tmpdir(), `veyyon-git-patch-${Snowflake.next()}.patch`);
	await Bun.write(tempPath, content);
	return tempPath;
}

export type EntryType = "directory" | "file";

export function shouldRetry(err: unknown, n: number) {
	if (isEnoent(err) || isEisdir(err) || isEnotdir(err) || hasFsCode(err, "ENFILE") || hasFsCode(err, "EMFILE"))
		return false;
	if (hasFsCode(err, "EINTR")) return n < EINTR_MAX_RETRIES;
	if (n > EINTR_MAX_RETRIES) throw err;
	throw err;
}

export const EINTR_MAX_RETRIES = 3;
export function retryOnEintrSync<T>(op: () => T): T | null {
	for (let attempt = 0; attempt <= EINTR_MAX_RETRIES; attempt += 1) {
		try {
			return op();
		} catch (err) {
			if (shouldRetry(err, attempt)) continue;
			return null;
		}
	}
	throw new Error("retryOnEintrSync: exhausted without resolution");
}
export async function retryOnEintr<T>(op: () => Promise<T>): Promise<T | null> {
	for (let attempt = 0; attempt <= EINTR_MAX_RETRIES; attempt += 1) {
		try {
			return await op();
		} catch (err) {
			if (shouldRetry(err, attempt)) continue;
			return null;
		}
	}
	throw new Error("retryOnEintr: exhausted without resolution");
}

export function getEntryTypeSync(gitEntryPath: string): EntryType | null {
	return retryOnEintrSync(() => {
		const stat = fs.statSync(gitEntryPath);
		if (stat.isDirectory()) return "directory";
		if (stat.isFile()) return "file";
		return null;
	});
}

export async function getEntryType(gitEntryPath: string): Promise<EntryType | null> {
	return retryOnEintr(async () => {
		const stat = await fs.promises.stat(gitEntryPath);
		if (stat.isDirectory()) return "directory";
		if (stat.isFile()) return "file";
		return null;
	});
}

export function readOptionalTextSync(filePath: string): string | null {
	return retryOnEintrSync(() => fs.readFileSync(filePath, "utf8"));
}

export async function readOptionalText(filePath: string): Promise<string | null> {
	return retryOnEintr(async () => await Bun.file(filePath).text());
}

export function parseGitDirPointer(content: string): string | null {
	const match = /^gitdir:\s*(.+)\s*$/iu.exec(content.trim());
	return match?.[1] ?? null;
}

export function resolveGitDirSync(gitEntryPath: string, entryType: EntryType): string | null {
	if (entryType === "directory") return gitEntryPath;
	const content = readOptionalTextSync(gitEntryPath);
	if (content === null) return null;
	const parsed = parseGitDirPointer(content);
	if (!parsed) return null;
	const gitDir = path.resolve(path.dirname(gitEntryPath), parsed);
	return getEntryTypeSync(gitDir) === "directory" ? gitDir : null;
}

export async function resolveGitDir(gitEntryPath: string, entryType: EntryType): Promise<string | null> {
	if (entryType === "directory") return gitEntryPath;
	const content = await readOptionalText(gitEntryPath);
	if (content === null) return null;
	const parsed = parseGitDirPointer(content);
	if (!parsed) return null;
	const gitDir = path.resolve(path.dirname(gitEntryPath), parsed);
	return (await getEntryType(gitDir)) === "directory" ? gitDir : null;
}

export function resolveCommonDirSync(gitDir: string): string {
	const content = readOptionalTextSync(path.join(gitDir, "commondir"));
	const relative = content?.trim();
	if (!relative) return gitDir;
	return path.resolve(gitDir, relative);
}

export async function resolveCommonDir(gitDir: string): Promise<string> {
	const content = await readOptionalText(path.join(gitDir, "commondir"));
	const relative = content?.trim();
	if (!relative) return gitDir;
	return path.resolve(gitDir, relative);
}
export function isLinkedWorktree(repository: GitRepository): boolean {
	return (
		repository.gitDir !== repository.commonDir &&
		getEntryTypeSync(path.join(repository.gitDir, "commondir")) === "file"
	);
}

export async function isLinkedWorktreeAsync(repository: GitRepository): Promise<boolean> {
	return (
		repository.gitDir !== repository.commonDir &&
		(await getEntryType(path.join(repository.gitDir, "commondir"))) === "file"
	);
}

export function primaryRootFromRepositorySync(repository: GitRepository): string {
	if (path.basename(repository.commonDir) === ".git") return path.dirname(repository.commonDir);
	if (isLinkedWorktree(repository)) return repository.commonDir;
	return repository.repoRoot;
}

export async function primaryRootFromRepository(repository: GitRepository): Promise<string> {
	if (path.basename(repository.commonDir) === ".git") return path.dirname(repository.commonDir);
	if (await isLinkedWorktreeAsync(repository)) return repository.commonDir;
	return repository.repoRoot;
}

export function resolveRepoFromEntrySync(
	repoRoot: string,
	gitEntryPath: string,
	entryType: EntryType,
): GitRepository | null {
	const gitDir = resolveGitDirSync(gitEntryPath, entryType);
	if (!gitDir) return null;
	return {
		commonDir: resolveCommonDirSync(gitDir),
		gitDir,
		gitEntryPath,
		headPath: path.join(gitDir, "HEAD"),
		repoRoot,
	};
}

export async function resolveRepoFromEntry(
	repoRoot: string,
	gitEntryPath: string,
	entryType: EntryType,
): Promise<GitRepository | null> {
	const gitDir = await resolveGitDir(gitEntryPath, entryType);
	if (!gitDir) return null;
	return {
		commonDir: await resolveCommonDir(gitDir),
		gitDir,
		gitEntryPath,
		headPath: path.join(gitDir, "HEAD"),
		repoRoot,
	};
}

export function resolveRepositorySync(startDir: string): GitRepository | null {
	let current = path.resolve(startDir);
	while (true) {
		const gitEntryPath = path.join(current, ".git");
		const entryType = getEntryTypeSync(gitEntryPath);
		if (entryType) {
			const repository = resolveRepoFromEntrySync(current, gitEntryPath, entryType);
			if (repository) return repository;
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export async function resolveRepository(startDir: string): Promise<GitRepository | null> {
	let current = path.resolve(startDir);
	while (true) {
		const gitEntryPath = path.join(current, ".git");
		const entryType = await getEntryType(gitEntryPath);
		if (entryType) {
			const repository = await resolveRepoFromEntry(current, gitEntryPath, entryType);
			if (repository) return repository;
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function getRefLookupDirs(repository: GitRepository): string[] {
	if (repository.gitDir === repository.commonDir) return [repository.gitDir];
	return [repository.gitDir, repository.commonDir];
}

export function normalizeRefValue(content: string | null): string | null {
	const trimmed = content?.trim() ?? "";
	return trimmed || null;
}

export function parsePackedRefs(content: string | null, targetRef: string): string | null {
	if (!content) return null;
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("^")) continue;
		const [sha, refName] = trimmed.split(" ", 2);
		if (refName === targetRef && sha) return sha;
	}
	return null;
}

export function stripGitConfigComments(line: string): string {
	let clean = "";
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === '"') {
			inQuotes = !inQuotes;
			clean += char;
		} else if (!inQuotes && (char === ";" || char === "#")) {
			break;
		} else {
			clean += char;
		}
	}
	return clean.trim();
}

export function parseGitConfigHasReftable(content: string): boolean {
	let inExtensions = false;
	for (const line of content.split("\n")) {
		const trimmed = stripGitConfigComments(line);
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			const section = trimmed.slice(1, -1).trim().toLowerCase();
			inExtensions = section === "extensions";
		} else if (inExtensions) {
			const eqIndex = trimmed.indexOf("=");
			if (eqIndex !== -1) {
				const key = trimmed.slice(0, eqIndex).trim().toLowerCase();
				let value = trimmed.slice(eqIndex + 1).trim();
				if (key === "refstorage") {
					if (value.startsWith('"') && value.endsWith('"')) {
						value = value.slice(1, -1).trim();
					}
					const lowerValue = value.toLowerCase();
					if (lowerValue === "reftable" || lowerValue.startsWith("reftable:")) {
						return true;
					}
				}
			}
		}
	}
	return false;
}

export function isReftableRepoSync(repository: GitRepository): boolean {
	if (repository.isReftable !== undefined) return repository.isReftable;
	const configPath = path.join(repository.commonDir, "config");
	const content = readOptionalTextSync(configPath);
	repository.isReftable = content ? parseGitConfigHasReftable(content) : false;
	return repository.isReftable;
}

export async function isReftableRepo(repository: GitRepository): Promise<boolean> {
	if (repository.isReftable !== undefined) return repository.isReftable;
	const configPath = path.join(repository.commonDir, "config");
	const content = await readOptionalText(configPath);
	repository.isReftable = content ? parseGitConfigHasReftable(content) : false;
	return repository.isReftable;
}

export async function resolveHeadStateReftable(
	repository: GitRepository,
	signal?: AbortSignal,
): Promise<GitHeadState | null> {
	throwIfAborted(signal);
	const symResult = await git(repository.repoRoot, ["symbolic-ref", "HEAD"], { readOnly: true, signal }).catch(err => {
		if (signal?.aborted || isAbortError(err)) {
			throw err;
		}
		return null;
	});
	throwIfAborted(signal);
	const revResult = await git(repository.repoRoot, ["rev-parse", "--verify", "HEAD"], {
		readOnly: true,
		signal,
	}).catch(err => {
		if (signal?.aborted || isAbortError(err)) {
			throw err;
		}
		return null;
	});
	const commit = revResult && revResult.exitCode === 0 ? revResult.stdout.trim() || null : null;

	if (symResult && symResult.exitCode === 0) {
		const ref = symResult.stdout.trim();
		const branchName = ref.startsWith(LOCAL_BRANCH_PREFIX) ? ref.slice(LOCAL_BRANCH_PREFIX.length) : null;
		return {
			...repository,
			kind: "ref",
			ref,
			branchName,
			commit,
			headContent: `${HEAD_REF_PREFIX} ${ref}`,
		};
	}

	return {
		...repository,
		kind: "detached",
		commit,
		headContent: commit || "",
	};
}

export function resolveHeadStateReftableSync(repository: GitRepository): GitHeadState | null {
	ensureAvailable();
	const symArgs = withShortLivedGitConfig(withNoOptionalLocks(["symbolic-ref", "HEAD"]));
	const symResult = Bun.spawnSync(["git", ...symArgs], {
		cwd: repository.repoRoot,
		env: buildGitEnv(),
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});

	const revArgs = withShortLivedGitConfig(withNoOptionalLocks(["rev-parse", "--verify", "HEAD"]));
	const revResult = Bun.spawnSync(["git", ...revArgs], {
		cwd: repository.repoRoot,
		env: buildGitEnv(),
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const commit = revResult.exitCode === 0 ? new TextDecoder().decode(revResult.stdout).trim() || null : null;

	if (symResult.exitCode === 0) {
		const ref = new TextDecoder().decode(symResult.stdout).trim();
		const branchName = ref.startsWith(LOCAL_BRANCH_PREFIX) ? ref.slice(LOCAL_BRANCH_PREFIX.length) : null;
		return {
			...repository,
			kind: "ref",
			ref,
			branchName,
			commit,
			headContent: `${HEAD_REF_PREFIX} ${ref}`,
		};
	}

	return {
		...repository,
		kind: "detached",
		commit,
		headContent: commit || "",
	};
}

export function readRefSync(repository: GitRepository, targetRef: string): string | null {
	if (isReftableRepoSync(repository)) {
		ensureAvailable();
		const symArgs = withShortLivedGitConfig(withNoOptionalLocks(["symbolic-ref", targetRef]));
		const symResult = Bun.spawnSync(["git", ...symArgs], {
			cwd: repository.repoRoot,
			env: buildGitEnv(),
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		if (symResult.exitCode === 0) {
			const stdoutText = new TextDecoder().decode(symResult.stdout).trim();
			return `${HEAD_REF_PREFIX} ${stdoutText}`;
		}
		const revArgs = withShortLivedGitConfig(withNoOptionalLocks(["rev-parse", "--verify", targetRef]));
		const revResult = Bun.spawnSync(["git", ...revArgs], {
			cwd: repository.repoRoot,
			env: buildGitEnv(),
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		if (revResult.exitCode === 0) {
			return new TextDecoder().decode(revResult.stdout).trim() || null;
		}
		return null;
	}

	for (const dir of getRefLookupDirs(repository)) {
		const value = normalizeRefValue(readOptionalTextSync(path.join(dir, targetRef)));
		if (value) return value;
	}
	for (const dir of getRefLookupDirs(repository)) {
		const value = parsePackedRefs(readOptionalTextSync(path.join(dir, "packed-refs")), targetRef);
		if (value) return value;
	}
	return null;
}

export async function readRef(
	repository: GitRepository,
	targetRef: string,
	signal?: AbortSignal,
): Promise<string | null> {
	if (await isReftableRepo(repository)) {
		throwIfAborted(signal);
		const symResult = await git(repository.repoRoot, ["symbolic-ref", targetRef], { readOnly: true, signal }).catch(
			err => {
				if (signal?.aborted || isAbortError(err)) {
					throw err;
				}
				return null;
			},
		);
		if (symResult && symResult.exitCode === 0) {
			return `${HEAD_REF_PREFIX} ${symResult.stdout.trim()}`;
		}
		throwIfAborted(signal);
		const revResult = await git(repository.repoRoot, ["rev-parse", "--verify", targetRef], {
			readOnly: true,
			signal,
		}).catch(err => {
			if (signal?.aborted || isAbortError(err)) {
				throw err;
			}
			return null;
		});
		if (revResult && revResult.exitCode === 0) {
			return revResult.stdout.trim() || null;
		}
		return null;
	}

	for (const dir of getRefLookupDirs(repository)) {
		const value = normalizeRefValue(await readOptionalText(path.join(dir, targetRef)));
		if (value) return value;
	}
	for (const dir of getRefLookupDirs(repository)) {
		const value = parsePackedRefs(await readOptionalText(path.join(dir, "packed-refs")), targetRef);
		if (value) return value;
	}
	return null;
}

export function readOperationHeadName(directory: string): string | null {
	const raw = readOptionalTextSync(path.join(directory, "head-name"))?.trim();
	if (!raw?.startsWith(LOCAL_BRANCH_PREFIX)) return null;
	return raw.slice(LOCAL_BRANCH_PREFIX.length) || null;
}

export function resolveInProgressOperation(repository: GitRepository): GitInProgressOperation | null {
	const gitDir = repository.gitDir;
	const rebaseMerge = path.join(gitDir, "rebase-merge");
	if (fs.existsSync(rebaseMerge)) {
		return { branch: readOperationHeadName(rebaseMerge), kind: "rebase" };
	}
	const rebaseApply = path.join(gitDir, "rebase-apply");
	if (fs.existsSync(rebaseApply)) {
		const isAm = fs.existsSync(path.join(rebaseApply, "applying"));
		return { branch: readOperationHeadName(rebaseApply), kind: isAm ? "am" : "rebase" };
	}
	if (fs.existsSync(path.join(gitDir, "MERGE_HEAD"))) return { branch: null, kind: "merge" };
	if (fs.existsSync(path.join(gitDir, "CHERRY_PICK_HEAD"))) return { branch: null, kind: "cherry-pick" };
	if (fs.existsSync(path.join(gitDir, "REVERT_HEAD"))) return { branch: null, kind: "revert" };
	if (fs.existsSync(path.join(gitDir, "BISECT_LOG"))) return { branch: null, kind: "bisect" };
	return null;
}

export function parseHeadStateSync(repository: GitRepository, headContent: string): GitHeadState {
	const trimmed = headContent.trim();
	if (!trimmed?.startsWith(HEAD_REF_PREFIX)) {
		return { ...repository, commit: trimmed || null, headContent, kind: "detached" };
	}
	const refValue = trimmed.slice(HEAD_REF_PREFIX.length).trim();
	const branchName = refValue.startsWith(LOCAL_BRANCH_PREFIX) ? refValue.slice(LOCAL_BRANCH_PREFIX.length) : null;
	return {
		...repository,
		branchName,
		commit: readRefSync(repository, refValue),
		headContent,
		kind: "ref",
		ref: refValue,
	};
}

export async function parseHeadState(repository: GitRepository, headContent: string): Promise<GitHeadState> {
	const trimmed = headContent.trim();
	if (!trimmed?.startsWith(HEAD_REF_PREFIX)) {
		return { ...repository, commit: trimmed || null, headContent, kind: "detached" };
	}
	const refValue = trimmed.slice(HEAD_REF_PREFIX.length).trim();
	const branchName = refValue.startsWith(LOCAL_BRANCH_PREFIX) ? refValue.slice(LOCAL_BRANCH_PREFIX.length) : null;
	return {
		...repository,
		branchName,
		commit: await readRef(repository, refValue),
		headContent,
		kind: "ref",
		ref: refValue,
	};
}

export function parseDefaultBranchRef(refPath: string, target: string | null): string | null {
	if (!target?.startsWith(HEAD_REF_PREFIX)) return null;
	const resolvedRef = target.slice(HEAD_REF_PREFIX.length).trim();
	const remotePrefix = refPath.slice(0, -"HEAD".length);
	if (!resolvedRef.startsWith(remotePrefix)) return null;
	return resolvedRef.slice(remotePrefix.length) || null;
}

export function stripRemotePrefix(refValue: string): string | null {
	const slash = refValue.indexOf("/");
	if (slash < 0) return refValue || null;
	return refValue.slice(slash + 1) || null;
}

export function parseWorktreeList(text: string): GitWorktreeEntry[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	return trimmed
		.split(/\n\s*\n/)
		.map(block => block.trim())
		.filter(Boolean)
		.map(block => {
			const entry: GitWorktreeEntry = { detached: false, path: "" };
			for (const line of block.split("\n")) {
				if (line.startsWith("worktree ")) entry.path = line.slice("worktree ".length);
				else if (line.startsWith("HEAD ")) entry.head = line.slice("HEAD ".length);
				else if (line.startsWith("branch ")) entry.branch = line.slice("branch ".length);
				else if (line === "detached") entry.detached = true;
			}
			return entry;
		});
}

export function extractFileHeader(diffText: string): string {
	const lines = diffText.split("\n");
	const headerLines: string[] = [];
	for (const line of lines) {
		if (line.startsWith("@@")) break;
		headerLines.push(line);
	}
	return headerLines.join("\n");
}
