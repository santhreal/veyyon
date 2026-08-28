import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage } from "@veyyon/utils/type-guards";
import { $which } from "@veyyon/utils/which";
import { parseDiffFileHunks, parseFileDiffs, parseFileHunks, parseNumstat } from "../commit/git/diff";
import type { FileDiff, FileHunks, NumstatEntry } from "../commit/types";
import { adoptIntoPrimarySessionCpuBudget } from "../session/cpu-limit";
import { ToolAbortError, ToolError, throwIfAborted } from "../tools/tool-errors";
import type {
	CloneOptions,
	CommandOptions,
	CommitDetails,
	CommitOptions,
	DiffOptions,
	FetchOptions,
	GitCommandResult,
	GitHeadState,
	GitInProgressOperation,
	GitRepository,
	GitStatusSummary,
	GitWorktreeEntry,
	HunkSelection,
	HunkSelectionValidationError,
	PatchOptions,
	PushOptions,
	RestoreOptions,
	StageHunksOptions,
	StatusOptions,
} from "./git-helpers";
import {
	buildApplyArgs,
	buildDiffArgs,
	collectSubprocessResult,
	DEFAULT_BRANCH_REFS,
	ensureAvailable,
	extractFileHeader,
	GH_NON_INTERACTIVE_ENV,
	GIT_NETWORK_TIMEOUT_MS,
	GIT_OUTPUT_TRUNCATED_NOTICE,
	GitCommandError,
	git,
	isLinkedWorktree,
	isReftableRepo,
	isReftableRepoSync,
	parseDefaultBranchRef,
	parseHeadState,
	parseHeadStateSync,
	parseWorktreeList,
	primaryRootFromRepository,
	primaryRootFromRepositorySync,
	readOptionalText,
	readOptionalTextSync,
	readRef,
	resolveHeadStateReftable,
	resolveHeadStateReftableSync,
	resolveInProgressOperation,
	resolveRepository,
	resolveRepositorySync,
	resolveTimeoutMs,
	runChecked,
	runEffect,
	runText,
	splitLines,
	stripRemotePrefix,
	trimScalar,
	tryText,
	writeTempPatch,
} from "./git-helpers";

export type {
	CloneOptions,
	CommandName,
	CommandOptions,
	CommitAuthor,
	CommitDetails,
	CommitOptions,
	DiffOptions,
	EntryType,
	FetchOptions,
	GitCommandResult,
	GitDetachedHead,
	GitHeadState,
	GitInProgressOperation,
	GitOperationKind,
	GitRefHead,
	GitRepository,
	GitStatusSummary,
	GitWorktreeEntry,
	HunkSelection,
	HunkSelectionValidationError,
	PatchOptions,
	PushOptions,
	RestoreOptions,
	StageHunksOptions,
	StatusOptions,
} from "./git-helpers";

export {
	GIT_COMMAND_OUTPUT_LIMIT_BYTES,
	GIT_COMMAND_TIMEOUT_MS,
	GIT_NETWORK_TIMEOUT_MS,
	GitCommandError,
	splitLines,
	withRepoLock,
} from "./git-helpers";

export function selectHunksByIndices<H extends { index: number }>(
	hunks: readonly H[],
	indices: readonly number[],
): H[] {
	const wanted = new Set(indices.map(v => Math.max(1, Math.floor(v))));
	return hunks.filter(hunk => wanted.has(hunk.index + 1));
}

function selectHunks(file: FileHunks, selector: HunkSelection["hunks"]): FileHunks["hunks"] {
	if (selector.type === "indices") {
		return selectHunksByIndices(file.hunks, selector.indices);
	}
	if (selector.type === "lines") {
		const start = Math.floor(selector.start);
		const end = Math.floor(selector.end);
		return file.hunks.filter(hunk => hunk.newStart <= end && hunk.newStart + hunk.newLines - 1 >= start);
	}
	return file.hunks;
}

export function createHunkSelectionValidator(
	rawDiff: string,
): (selections: readonly HunkSelection[]) => HunkSelectionValidationError[] {
	const fileDiffMap = new Map(parseFileDiffs(rawDiff).map(entry => [entry.filename, entry]));
	return selections => validateHunkSelectionsFromMap(fileDiffMap, selections);
}

function validateHunkSelectionsFromMap(
	fileDiffMap: ReadonlyMap<string, FileDiff>,
	selections: readonly HunkSelection[],
): HunkSelectionValidationError[] {
	const errors: HunkSelectionValidationError[] = [];

	for (const selection of selections) {
		const fileDiff = fileDiffMap.get(selection.path);
		if (!fileDiff) continue;
		if (selection.hunks.type === "all") continue;
		if (fileDiff.isBinary) {
			errors.push({ path: selection.path, message: `Cannot select hunks for binary file ${selection.path}` });
			continue;
		}

		let selected: FileHunks["hunks"];
		try {
			selected = selectHunks(parseFileHunks(fileDiff), selection.hunks);
		} catch (err) {
			errors.push({ path: selection.path, message: errorMessage(err) });
			continue;
		}
		if (selected.length === 0) {
			errors.push({ path: selection.path, message: `No hunks selected for ${selection.path}` });
		}
	}

	return errors;
}

export function validateHunkSelections(
	rawDiff: string,
	selections: readonly HunkSelection[],
): HunkSelectionValidationError[] {
	return createHunkSelectionValidator(rawDiff)(selections);
}

function parseStatusPorcelain(text: string): GitStatusSummary {
	let staged = 0;
	let unstaged = 0;
	let untracked = 0;
	let truncated = false;
	for (const line of text.split("\n")) {
		if (!line) continue;
		if (line === GIT_OUTPUT_TRUNCATED_NOTICE) {
			truncated = true;
			continue;
		}
		const x = line[0];
		const y = line[1];
		if (x === "?" && y === "?") {
			untracked += 1;
			continue;
		}
		if (x && x !== " " && x !== "?") staged += 1;
		if (y && y !== " ") unstaged += 1;
	}
	return { staged, truncated, unstaged, untracked };
}

export const diff = Object.assign(
	async function diff(cwd: string, options: DiffOptions = {}): Promise<string> {
		const args = buildDiffArgs(options);
		if (options.allowFailure) {
			return (await git(cwd, args, { env: options.env, readOnly: true, signal: options.signal })).stdout;
		}
		return runText(cwd, args, { env: options.env, readOnly: true, signal: options.signal });
	},
	{
		async changedFiles(
			cwd: string,
			options: Pick<DiffOptions, "cached" | "files" | "signal"> = {},
		): Promise<string[]> {
			return splitLines(await diff(cwd, { ...options, nameOnly: true }));
		},
		async numstat(cwd: string, options: Pick<DiffOptions, "cached" | "signal"> = {}): Promise<NumstatEntry[]> {
			return parseNumstat(await diff(cwd, { ...options, numstat: true }));
		},
		async hunks(
			cwd: string,
			files: readonly string[],
			options: { cached?: boolean; signal?: AbortSignal } = {},
		): Promise<FileHunks[]> {
			return parseDiffFileHunks(await diff(cwd, { cached: options.cached ?? true, files, signal: options.signal }));
		},
		async has(cwd: string, options: Pick<DiffOptions, "cached" | "files" | "signal"> = {}): Promise<boolean> {
			const args = ["diff"];
			if (options.cached) args.push("--cached");
			args.push("--quiet");
			if (options.files?.length) args.push("--", ...options.files);
			const result = await git(cwd, args, { readOnly: true, signal: options.signal });
			if (result.exitCode === 0) return false;
			if (result.exitCode === 1) return true;
			throw new GitCommandError(args, result);
		},
		async tree(
			cwd: string,
			base: string,
			headRef: string,
			options: { binary?: boolean; signal?: AbortSignal; allowFailure?: boolean } = {},
		): Promise<string> {
			const args = ["diff-tree", "-r", "-p"];
			if (options.binary) args.push("--binary");
			args.push(base, headRef);
			if (options.allowFailure) {
				return (await git(cwd, args, { readOnly: true, signal: options.signal })).stdout;
			}
			return runText(cwd, args, { readOnly: true, signal: options.signal });
		},
		parseFiles(text: string): FileDiff[] {
			return parseFileDiffs(text);
		},
		parseHunks(text: string): FileHunks[] {
			return parseDiffFileHunks(text);
		},
	},
);

export const status = Object.assign(
	async function status(cwd: string, options: StatusOptions = {}): Promise<string> {
		const args = ["status"];
		args.push(options.porcelainV1 ? "--porcelain=v1" : "--porcelain");
		if (options.z) args.push("-z");
		if (options.untrackedFiles) args.push(`--untracked-files=${options.untrackedFiles}`);
		if (options.pathspecs?.length) args.push("--", ...options.pathspecs);
		return runText(cwd, args, { readOnly: true, signal: options.signal });
	},
	{
		async summary(cwd: string, signal?: AbortSignal): Promise<GitStatusSummary | null> {
			const result = await git(cwd, ["status", "--porcelain"], { readOnly: true, signal });
			if (result.exitCode !== 0) return null;
			return parseStatusPorcelain(result.stdout);
		},
		parse: parseStatusPorcelain,
	},
);

export const stage = {
	async files(cwd: string, files: readonly string[] = [], signal?: AbortSignal): Promise<void> {
		const args = files.length === 0 ? ["add", "-A"] : ["add", "--", ...files];
		await runEffect(cwd, args, { signal });
	},

	async hunks(cwd: string, selections: HunkSelection[], options: StageHunksOptions = {}): Promise<void> {
		if (selections.length === 0) return;
		const rawDiff = options.rawDiff ?? (await diff(cwd, { cached: options.diffCached, signal: options.signal }));
		const fileDiffs = parseFileDiffs(rawDiff);
		const fileDiffMap = new Map(fileDiffs.map(entry => [entry.filename, entry]));
		const patchParts: string[] = [];

		for (const selection of selections) {
			const fileDiff = fileDiffMap.get(selection.path);
			if (!fileDiff) throw new Error(`No diff found for ${selection.path}`);
			if (fileDiff.isBinary) {
				if (selection.hunks.type !== "all")
					throw new Error(`Cannot select hunks for binary file ${selection.path}`);
				patchParts.push(fileDiff.content);
				continue;
			}
			if (selection.hunks.type === "all") {
				patchParts.push(fileDiff.content);
				continue;
			}
			const fileHunks = parseFileHunks(fileDiff);
			const selected = selectHunks(fileHunks, selection.hunks);
			if (selected.length === 0) throw new Error(`No hunks selected for ${selection.path}`);
			const header = extractFileHeader(fileDiff.content);
			patchParts.push([header, ...selected.map(h => h.content)].join("\n"));
		}

		const patchText = patch.join(patchParts);
		if (!patchText.trim()) return;
		await patch.applyText(cwd, patchText, { cached: true, signal: options.signal });
	},

	async reset(cwd: string, files: readonly string[] = [], signal?: AbortSignal): Promise<void> {
		const args = files.length === 0 ? ["reset"] : ["reset", "--", ...files];
		await runEffect(cwd, args, { signal });
	},
};

export async function commit(cwd: string, message: string, options: CommitOptions = {}): Promise<GitCommandResult> {
	const args = ["commit", "-F", "-"];
	if (options.author) {
		args.push(`--author=${options.author.name} <${options.author.email}>`);
		if (options.author.date) args.push(`--date=${options.author.date}`);
	}
	if (options.allowEmpty) args.push("--allow-empty");
	if (options.files?.length) args.push("--", ...options.files);
	return runChecked(cwd, args, { signal: options.signal, stdin: message });
}

export async function push(cwd: string, options: PushOptions = {}): Promise<void> {
	const args = ["push", "--no-follow-tags"];
	if (options.forceWithLease) args.push("--force-with-lease");
	if (options.remote) args.push(options.remote);
	if (options.refspec) args.push(options.refspec);
	await runEffect(cwd, args, { signal: options.signal });
}

export async function checkout(cwd: string, ref: string, signal?: AbortSignal): Promise<void> {
	await runEffect(cwd, ["checkout", ref], { signal });
}

export async function fetch(
	cwd: string,
	remote: string,
	source: string,
	target: string,
	options: FetchOptions = {},
): Promise<void> {
	await runEffect(cwd, ["fetch", remote, `+${source}:${target}`], {
		signal: options.signal,
		timeoutMs: resolveTimeoutMs(options.timeoutMs, GIT_NETWORK_TIMEOUT_MS),
	});
}

export async function readTree(
	cwd: string,
	treeish: string,
	options: Pick<CommandOptions, "env" | "signal"> = {},
): Promise<void> {
	await runEffect(cwd, ["read-tree", treeish], options);
}

export async function writeTree(cwd: string, options: Pick<CommandOptions, "env" | "signal"> = {}): Promise<string> {
	return (await runText(cwd, ["write-tree"], options)).trim();
}

export const show = Object.assign(
	async function show(
		cwd: string,
		revision: string,
		options: { format?: string; signal?: AbortSignal } = {},
	): Promise<string> {
		return runText(cwd, ["show", `--format=${options.format ?? ""}`, revision], {
			readOnly: true,
			signal: options.signal,
		});
	},
	{
		async prefix(cwd: string, signal?: AbortSignal): Promise<string> {
			return (await runText(cwd, ["rev-parse", "--show-prefix"], { readOnly: true, signal })).trim();
		},
	},
);

export async function commitDetails(cwd: string, revision: string, signal?: AbortSignal): Promise<CommitDetails> {
	const raw = await runText(cwd, ["show", "-s", "--format=%an%x00%ae%x00%aI%x00%B", revision], {
		readOnly: true,
		signal,
	});
	const [name = "", email = "", date = "", ...messageParts] = raw.split("\0");
	return {
		author: { date, email, name },
		message: messageParts.join("\0").replace(/\n$/, ""),
	};
}

export const log = {
	async subjects(cwd: string, count: number, signal?: AbortSignal): Promise<string[]> {
		return splitLines(await runText(cwd, ["log", `-n${count}`, "--pretty=format:%s"], { readOnly: true, signal }));
	},
	async onelines(cwd: string, count: number, signal?: AbortSignal): Promise<string[]> {
		return splitLines(
			await runText(cwd, ["log", `-${count}`, "--oneline", "--no-decorate"], { readOnly: true, signal }),
		);
	},
};

export const revList = {
	async range(cwd: string, base: string, head: string, signal?: AbortSignal): Promise<string[]> {
		return splitLines(await runText(cwd, ["rev-list", "--reverse", `${base}..${head}`], { readOnly: true, signal }));
	},
};

export const branch = {
	async current(cwd: string, signal?: AbortSignal): Promise<string | null> {
		const headState = await resolveHead(cwd);
		if (headState?.kind === "ref") return headState.branchName ?? headState.ref;
		const result = await git(cwd, ["symbolic-ref", "--short", "HEAD"], { readOnly: true, signal });
		if (result.exitCode !== 0) return null;
		return result.stdout.trim() || null;
	},

	async currentOrHead(cwd: string, signal?: AbortSignal): Promise<string> {
		try {
			return (await branch.current(cwd, signal)) ?? "HEAD";
		} catch {
			return "HEAD";
		}
	},

	async default(cwd: string, signal?: AbortSignal): Promise<string | null> {
		const repository = await resolveRepository(cwd);
		if (repository) {
			for (const refPath of DEFAULT_BRANCH_REFS) {
				const target = await readRef(repository, refPath, signal);
				const branchName = parseDefaultBranchRef(refPath, target);
				if (branchName) return branchName;
			}
		}
		for (const remoteRef of ["origin/HEAD", "upstream/HEAD"]) {
			const result = await git(cwd, ["rev-parse", "--abbrev-ref", remoteRef], { readOnly: true, signal });
			if (result.exitCode !== 0) continue;
			const branchName = stripRemotePrefix(result.stdout.trim());
			if (branchName) return branchName;
		}
		return null;
	},

	async create(cwd: string, name: string, startPoint = "HEAD", signal?: AbortSignal): Promise<void> {
		await runEffect(cwd, ["branch", name, startPoint], { signal });
	},

	async force(cwd: string, name: string, startPoint: string, signal?: AbortSignal): Promise<void> {
		await runEffect(cwd, ["branch", "--force", name, startPoint], { signal });
	},

	async delete(cwd: string, name: string, options: { force?: boolean; signal?: AbortSignal } = {}): Promise<void> {
		await runEffect(cwd, ["branch", options.force === false ? "-d" : "-D", name], { signal: options.signal });
	},

	async tryDelete(
		cwd: string,
		name: string,
		options: { force?: boolean; signal?: AbortSignal } = {},
	): Promise<boolean> {
		const result = await git(cwd, ["branch", options.force === false ? "-d" : "-D", name], {
			signal: options.signal,
		});
		return result.exitCode === 0;
	},

	async checkoutNew(cwd: string, name: string, signal?: AbortSignal): Promise<void> {
		await runEffect(cwd, ["checkout", "-b", name], { signal });
	},

	async list(cwd: string, options: { all?: boolean; signal?: AbortSignal } = {}): Promise<string[]> {
		const args = ["branch"];
		if (options.all) args.push("-a");
		args.push("--format=%(refname:short)");
		return splitLines(await runText(cwd, args, { readOnly: true, signal: options.signal }));
	},
};

export const remote = {
	async list(cwd: string, signal?: AbortSignal): Promise<string[]> {
		return splitLines(await runText(cwd, ["remote"], { readOnly: true, signal }));
	},

	async url(cwd: string, name: string, signal?: AbortSignal): Promise<string | undefined> {
		return trimScalar(await tryText(cwd, ["remote", "get-url", name], { readOnly: true, signal }));
	},

	async add(cwd: string, name: string, url: string, signal?: AbortSignal): Promise<void> {
		const result = await git(cwd, ["remote", "add", name, url], { signal });
		if (result.exitCode === 0) return;
		const existing = await remote.url(cwd, name, signal);
		if (existing !== undefined) {
			if (existing === url) return;
			throw new ToolError(`remote ${name} already exists with URL ${existing}, expected ${url}`);
		}
		throw new GitCommandError(["remote", "add", name, url], result);
	},
};

export const ref = {
	async exists(cwd: string, refName: string, signal?: AbortSignal): Promise<boolean> {
		if (refName === "HEAD") return (await head.sha(cwd, signal)) !== null;
		const repository = await resolveRepository(cwd);
		if (repository && refName.startsWith("refs/")) return (await readRef(repository, refName, signal)) !== null;
		const result = await git(cwd, ["show-ref", "--verify", "--quiet", refName], { readOnly: true, signal });
		return result.exitCode === 0;
	},

	async resolve(cwd: string, refName: string, signal?: AbortSignal): Promise<string | null> {
		if (refName === "HEAD") return head.sha(cwd, signal);
		const repository = await resolveRepository(cwd);
		if (repository && refName.startsWith("refs/")) return readRef(repository, refName, signal);
		const result = await git(cwd, ["rev-parse", refName], { readOnly: true, signal });
		if (result.exitCode !== 0) return null;
		return result.stdout.trim() || null;
	},

	async tags(cwd: string, refName = "HEAD", signal?: AbortSignal): Promise<string[]> {
		return splitLines(
			await runText(
				cwd,
				[
					"for-each-ref",
					"--points-at",
					refName,
					"--sort=-version:refname",
					"--format=%(refname:strip=2)",
					"refs/tags",
				],
				{ readOnly: true, signal },
			),
		);
	},
};

export const config = {
	async get(cwd: string, key: string, signal?: AbortSignal): Promise<string | undefined> {
		return trimScalar(await tryText(cwd, ["config", "--get", key], { readOnly: true, signal }));
	},

	async set(cwd: string, key: string, value: string, signal?: AbortSignal): Promise<void> {
		await runEffect(cwd, ["config", key, value], { signal });
	},

	async getBranch(cwd: string, branchName: string, key: string, signal?: AbortSignal): Promise<string | undefined> {
		return config.get(cwd, `branch.${branchName}.${key}`, signal);
	},

	async setBranch(cwd: string, branchName: string, key: string, value: string, signal?: AbortSignal): Promise<void> {
		return config.set(cwd, `branch.${branchName}.${key}`, value, signal);
	},
};

export const worktree = {
	async add(
		cwd: string,
		worktreePath: string,
		refName: string,
		options: { detach?: boolean; signal?: AbortSignal } = {},
	): Promise<void> {
		const args = ["worktree", "add"];
		if (options.detach) args.push("--detach");
		args.push(worktreePath, refName);
		await runEffect(cwd, args, { signal: options.signal });
	},

	async remove(
		cwd: string,
		worktreePath: string,
		options: { force?: boolean; signal?: AbortSignal } = {},
	): Promise<void> {
		const args = ["worktree", "remove"];
		if (options.force ?? true) args.push("-f");
		args.push(worktreePath);
		await runEffect(cwd, args, { signal: options.signal });
	},

	async tryRemove(
		cwd: string,
		worktreePath: string,
		options: { force?: boolean; signal?: AbortSignal } = {},
	): Promise<boolean> {
		const args = ["worktree", "remove"];
		if (options.force ?? true) args.push("-f");
		args.push(worktreePath);
		const result = await git(cwd, args, { signal: options.signal });
		return result.exitCode === 0;
	},

	async list(cwd: string, signal?: AbortSignal): Promise<GitWorktreeEntry[]> {
		return parseWorktreeList(await runText(cwd, ["worktree", "list", "--porcelain"], { readOnly: true, signal }));
	},

	async prune(cwd: string, signal?: AbortSignal): Promise<void> {
		await runEffect(cwd, ["worktree", "prune"], { signal });
	},
};

export const patch = {
	async apply(cwd: string, patchPath: string, options: PatchOptions = {}): Promise<void> {
		await runEffect(cwd, buildApplyArgs(patchPath, options), { env: options.env, signal: options.signal });
	},

	async applyText(cwd: string, patchText: string, options: PatchOptions = {}): Promise<void> {
		if (!patchText.trim()) return;
		const tempPath = await writeTempPatch(patchText);
		try {
			await patch.apply(cwd, tempPath, options);
		} finally {
			await fs.promises.rm(tempPath, { force: true });
		}
	},

	async canApply(cwd: string, patchPath: string, options: Omit<PatchOptions, "check"> = {}): Promise<boolean> {
		const result = await git(cwd, buildApplyArgs(patchPath, { ...options, check: true }), {
			env: options.env,
			readOnly: true,
			signal: options.signal,
		});
		return result.exitCode === 0;
	},

	async canApplyText(cwd: string, patchText: string, options: Omit<PatchOptions, "check"> = {}): Promise<boolean> {
		if (!patchText.trim()) return true;
		const tempPath = await writeTempPatch(patchText);
		try {
			return await patch.canApply(cwd, tempPath, options);
		} finally {
			await fs.promises.rm(tempPath, { force: true });
		}
	},

	join(parts: string[]): string {
		return `${parts
			.map(part => (part.endsWith("\n") ? part : `${part}\n`))
			.join("\n")
			.replace(/\n+$/, "")}\n`;
	},
};

export const cherryPick = Object.assign(
	async function cherryPick(cwd: string, revision: string, signal?: AbortSignal): Promise<void> {
		await runEffect(cwd, ["cherry-pick", revision], { signal });
	},
	{
		async abort(cwd: string, signal?: AbortSignal): Promise<void> {
			await runEffect(cwd, ["cherry-pick", "--abort"], { signal });
		},
		async skip(cwd: string, signal?: AbortSignal): Promise<void> {
			await runEffect(cwd, ["cherry-pick", "--skip"], { signal });
		},
		isEmptyError(err: unknown): boolean {
			return err instanceof GitCommandError && /the previous cherry-pick is now empty/i.test(err.result.stderr);
		},
	},
);

export const stash = {
	async push(cwd: string, message?: string): Promise<boolean> {
		ensureAvailable();
		const previousStash = await ref.resolve(cwd, "refs/stash");
		const args = ["stash", "push", "--include-untracked"];
		if (message) args.push("-m", message);
		await runEffect(cwd, args);
		const nextStash = await ref.resolve(cwd, "refs/stash");
		return nextStash !== null && nextStash !== previousStash;
	},
	async pop(cwd: string, options?: { index?: boolean }): Promise<void> {
		const args = ["stash", "pop"];
		if (options?.index) args.push("--index");
		await runEffect(cwd, args);
	},
	async showPatch(cwd: string): Promise<string> {
		return (await tryText(cwd, ["stash", "show", "-p", "--binary", "stash@{0}"], { readOnly: true })) ?? "";
	},
	async untrackedFiles(cwd: string): Promise<string[]> {
		const output = await tryText(cwd, ["ls-tree", "-r", "-z", "--name-only", "stash@{0}^3"], { readOnly: true });
		return output?.split("\0").filter(Boolean) ?? [];
	},
	async tryPop(cwd: string, options?: { index?: boolean }): Promise<boolean> {
		const workingPatch = await stash.showPatch(cwd);
		if (workingPatch.trim() && !(await patch.canApplyText(cwd, workingPatch, { threeWay: true }))) {
			return false;
		}
		const restoredUntracked = await stash.untrackedFiles(cwd);
		try {
			await stash.pop(cwd, options);
			return true;
		} catch {
			try {
				await reset(cwd, { hard: true });
			} catch {}
			if (restoredUntracked.length > 0) {
				try {
					await clean(cwd, { includeIgnored: true, literalPathspecs: true, paths: restoredUntracked });
				} catch {}
			}
			return false;
		}
	},
};

export async function clone(url: string, targetDir: string, options: CloneOptions = {}): Promise<void> {
	ensureAvailable();
	const absoluteTarget = path.resolve(targetDir);
	await fs.promises.mkdir(path.dirname(absoluteTarget), { recursive: true });

	const shallow = !options.sha;
	const args = ["clone"];
	if (shallow) args.push("--depth", "1");
	if (options.ref) args.push("--branch", options.ref, "--single-branch");
	else if (shallow) args.push("--single-branch");
	args.push(url, absoluteTarget);

	try {
		await runEffect(path.dirname(absoluteTarget), args, {
			signal: options.signal,
			timeoutMs: resolveTimeoutMs(options.timeoutMs, GIT_NETWORK_TIMEOUT_MS),
		});
		if (options.sha) {
			try {
				await checkout(absoluteTarget, options.sha, options.signal);
			} catch {
				await fs.promises.rm(absoluteTarget, { force: true, recursive: true });
				throw new Error(`Failed to checkout SHA ${options.sha} in cloned repository ${url}`);
			}
		}
	} catch (err) {
		await fs.promises.rm(absoluteTarget, { force: true, recursive: true });
		throw err;
	}
}

export async function restore(cwd: string, options: RestoreOptions = {}): Promise<void> {
	const args = ["restore"];
	if (options.source) args.push(`--source=${options.source}`);
	if (options.staged) args.push("--staged");
	if (options.worktree) args.push("--worktree");
	if (options.files?.length) args.push("--", ...options.files);
	await runEffect(cwd, args, { signal: options.signal });
}

export async function reset(
	cwd: string,
	options: { hard?: boolean; mixed?: boolean; soft?: boolean; target?: string; signal?: AbortSignal } = {},
): Promise<void> {
	const args = ["reset"];
	if (options.hard) args.push("--hard");
	else if (options.mixed) args.push("--mixed");
	else if (options.soft) args.push("--soft");
	if (options.target) args.push(options.target);
	await runEffect(cwd, args, { signal: options.signal });
}

export async function clean(
	cwd: string,
	options: {
		ignoredOnly?: boolean;
		includeIgnored?: boolean;
		literalPathspecs?: boolean;
		paths?: readonly string[];
		signal?: AbortSignal;
	} = {},
): Promise<void> {
	const args = [options.literalPathspecs ? "--literal-pathspecs" : undefined, "clean"].filter(
		(arg): arg is string => arg !== undefined,
	);
	args.push(options.ignoredOnly ? "-fdX" : options.includeIgnored ? "-fdx" : "-fd");
	if (options.paths?.length) args.push("--", ...options.paths);
	await runEffect(cwd, args, { signal: options.signal });
}

export const ls = {
	async files(
		cwd: string,
		options: { others?: boolean; excludeStandard?: boolean; signal?: AbortSignal } = {},
	): Promise<string[]> {
		const args = ["ls-files"];
		if (options.others) args.push("--others");
		if (options.excludeStandard) args.push("--exclude-standard");
		return splitLines(await runText(cwd, args, { readOnly: true, signal: options.signal }));
	},

	async untracked(cwd: string, signal?: AbortSignal): Promise<string[]> {
		return ls.files(cwd, { others: true, excludeStandard: true, signal });
	},

	async tree(cwd: string, ref: string, files: readonly string[] = [], signal?: AbortSignal): Promise<string[]> {
		const args = ["ls-tree", "--name-only", "-r", "-z", ref];
		if (files.length > 0) args.push("--", ...files);
		const raw = await runText(cwd, args, { readOnly: true, signal });
		return raw.split("\0").filter(entry => entry.length > 0);
	},

	async submodules(cwd: string, signal?: AbortSignal): Promise<string[]> {
		const output = await git(cwd, ["submodule", "--quiet", "foreach", "--recursive", "echo $sm_path"], {
			readOnly: true,
			signal,
		});
		return splitLines(output.stdout);
	},
};

export const head = {
	operation(repository: GitRepository): GitInProgressOperation | null {
		return resolveInProgressOperation(repository);
	},

	label(state: GitHeadState, operation: GitInProgressOperation | null): string {
		const fromHead = state.kind === "ref" ? (state.branchName ?? state.ref) : null;

		const branch = fromHead ?? operation?.branch ?? "detached";
		return operation ? `${branch}|${operation.kind.toUpperCase()}` : branch;
	},

	branchForLookup(state: GitHeadState, operation: GitInProgressOperation | null): string | null {
		if (operation) return null;
		if (state.kind !== "ref") return null;
		return state.branchName;
	},

	async resolve(cwd: string, signal?: AbortSignal): Promise<GitHeadState | null> {
		const repository = await resolveRepository(cwd);
		if (!repository) return null;
		if (await isReftableRepo(repository)) {
			return resolveHeadStateReftable(repository, signal);
		}
		const content = await readOptionalText(repository.headPath);
		if (content === null) return null;
		return parseHeadState(repository, content);
	},

	resolveSync(cwd: string): GitHeadState | null {
		const repository = resolveRepositorySync(cwd);
		if (!repository) return null;
		if (isReftableRepoSync(repository)) {
			return resolveHeadStateReftableSync(repository);
		}
		const content = readOptionalTextSync(repository.headPath);
		if (content === null) return null;
		return parseHeadStateSync(repository, content);
	},

	async sha(cwd: string, signal?: AbortSignal): Promise<string | null> {
		const headState = await head.resolve(cwd, signal);
		if (headState?.commit) return headState.commit;
		const result = await git(cwd, ["rev-parse", "HEAD"], { readOnly: true, signal });
		if (result.exitCode !== 0) return null;
		return result.stdout.trim() || null;
	},

	async short(cwd: string, length = 7, signal?: AbortSignal): Promise<string | null> {
		const result = await git(cwd, ["rev-parse", `--short=${length}`, "HEAD"], { readOnly: true, signal });
		if (result.exitCode !== 0) return null;
		return result.stdout.trim() || null;
	},
};

export const repo = {
	async root(cwd: string, signal?: AbortSignal): Promise<string | null> {
		const repository = await resolveRepository(cwd);
		if (repository) return repository.repoRoot;
		const result = await git(cwd, ["rev-parse", "--show-toplevel"], { readOnly: true, signal });
		if (result.exitCode !== 0) return null;
		return result.stdout.trim() || null;
	},

	async ignored(root: string, paths: readonly string[], signal?: AbortSignal): Promise<Set<string> | null> {
		if (paths.length === 0) return new Set();
		const result = await git(root, ["check-ignore", "-z", "--stdin"], {
			readOnly: true,
			signal,
			stdin: `${paths.join("\0")}\0`,
		});
		if (result.exitCode > 1) return null;
		return new Set(result.stdout.split("\0").filter(entry => entry.length > 0));
	},

	async primaryRoot(cwd: string, signal?: AbortSignal): Promise<string | null> {
		const repository = await resolveRepository(cwd);
		if (repository) return primaryRootFromRepository(repository);
		const repoRoot = await repo.root(cwd, signal);
		if (!repoRoot) return null;
		const commonDir = await runText(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
			readOnly: true,
			signal,
		});
		if (path.basename(commonDir.trim()) === ".git") return path.dirname(commonDir.trim());
		return repoRoot;
	},

	primaryRootSync(cwd: string): string | null {
		const repository = resolveRepositorySync(cwd);
		if (!repository) return null;
		return primaryRootFromRepositorySync(repository);
	},

	linkedWorktreeSync(cwd: string): { root: string; primaryRoot: string } | null {
		const repository = resolveRepositorySync(cwd);
		if (!repository || !isLinkedWorktree(repository)) return null;
		return { root: repository.repoRoot, primaryRoot: primaryRootFromRepositorySync(repository) };
	},

	resolveSync(cwd: string): GitRepository | null {
		return resolveRepositorySync(cwd);
	},

	resolve(cwd: string): Promise<GitRepository | null> {
		return resolveRepository(cwd);
	},

	isReftableSync(repository: GitRepository): boolean {
		return isReftableRepoSync(repository);
	},

	isReftable(repository: GitRepository): Promise<boolean> {
		return isReftableRepo(repository);
	},
};

async function resolveHead(cwd: string, signal?: AbortSignal): Promise<GitHeadState | null> {
	return head.resolve(cwd, signal);
}

export interface GhCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface GhCommandOptions {
	repoProvided?: boolean;
	trimOutput?: boolean;
}

function formatGhFailure(args: readonly string[], stdout: string, stderr: string, options?: GhCommandOptions): string {
	const message = (stderr || stdout).trim();
	if (message.includes("gh auth login") || message.includes("not logged into any GitHub hosts")) {
		return "GitHub CLI is not authenticated. Run `gh auth login`.";
	}
	if (
		!options?.repoProvided &&
		(message.includes("not a git repository") ||
			message.includes("no git remotes found") ||
			message.includes("unable to determine current repository"))
	) {
		return "GitHub repository context is unavailable. Pass `repo` explicitly or run the tool inside a GitHub checkout.";
	}
	if (message.length > 0) return message;
	return `GitHub CLI command failed: gh ${args.join(" ")}`;
}

export const github = {
	available(): boolean {
		return Boolean($which("gh"));
	},

	async run(cwd: string, args: string[], signal?: AbortSignal, options?: GhCommandOptions): Promise<GhCommandResult> {
		throwIfAborted(signal);
		if (!$which("gh")) {
			throw new ToolError("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/.");
		}
		try {
			const child = Bun.spawn(["gh", ...args], {
				cwd,
				env: {
					...process.env,
					...GH_NON_INTERACTIVE_ENV,
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
				signal,
			});
			adoptIntoPrimarySessionCpuBudget(child.pid);
			const { stdout, stderr, exitCode } = await collectSubprocessResult("gh", args, child, {});
			throwIfAborted(signal);
			const trim = options?.trimOutput !== false;
			return {
				exitCode: exitCode ?? 0,
				stdout: trim ? stdout.trim() : stdout,
				stderr: trim ? stderr.trim() : stderr,
			};
		} catch (error) {
			if (signal?.aborted) throw new ToolAbortError();
			throw error;
		}
	},

	async json<T>(cwd: string, args: string[], signal?: AbortSignal, options?: GhCommandOptions): Promise<T> {
		const result = await github.run(cwd, args, signal, options);
		if (result.exitCode !== 0) {
			throw new ToolError(formatGhFailure(args, result.stdout, result.stderr, options));
		}
		if (!result.stdout) {
			throw new ToolError("GitHub CLI returned empty output.");
		}
		try {
			return JSON.parse(result.stdout) as T;
		} catch {
			throw new ToolError("GitHub CLI returned invalid JSON output.");
		}
	},

	async text(cwd: string, args: string[], signal?: AbortSignal, options?: GhCommandOptions): Promise<string> {
		const result = await github.run(cwd, args, signal, options);
		if (result.exitCode !== 0) {
			throw new ToolError(formatGhFailure(args, result.stdout, result.stderr, options));
		}
		return result.stdout;
	},
};
