import * as fs from "node:fs";
import * as path from "node:path";
import { isMissingPath } from "@veyyon/utils";
import type { Skill } from "../extensibility/skills";
import { InternalUrlRouter, type LocalProtocolOptions } from "../internal-urls";
import {
	expandDelimitedPathEntries,
	formatPathRelativeToCwd,
	hasGlobPathChars,
	isReadableUrlPath,
	isSshUrl,
	normalizePathLikeInput,
	parseSearchPath,
	parseSearchPathPreferringLiteral,
	partitionExistingPaths,
	type ResolvedSearchTarget,
	resolveExplicitSearchPaths,
	resolveToCwd,
} from "./path-utils";
import { ToolError } from "./tool-errors";

export interface ResolvedExternalSearchUrl {
	sourcePath: string;
	immutable?: boolean;
}

export interface ToolScopeOptions {
	rawPaths: string[];
	cwd: string;
	internalUrlAction: string;
	trackImmutableSources?: boolean;
	surfaceExactFilePaths?: boolean;
	fanOutFileTargets?: boolean;
	multipathStatHint?: string;
	settings?: unknown;
	signal?: AbortSignal;
	localProtocolOptions?: LocalProtocolOptions;
	skills?: readonly Skill[];
	resolveExternalUrl?: (rawPath: string) => Promise<ResolvedExternalSearchUrl | undefined>;
}

export interface ToolScopeResolution {
	searchPath: string;
	scopePath: string;
	globFilter: string | undefined;
	isDirectory: boolean;
	multiTargets?: ResolvedSearchTarget[];
	exactFilePaths?: string[];
	missingPaths: string[];
	immutableSourcePaths: Set<string>;
}

export async function resolveToolSearchScope(opts: ToolScopeOptions): Promise<ToolScopeResolution> {
	const { rawPaths: inputs, cwd, internalUrlAction } = opts;
	const normalizedRawPaths = inputs.map(normalizePathLikeInput);
	if (normalizedRawPaths.some(rawPath => rawPath.length === 0)) {
		throw new ToolError("Search scope entries must be non-empty paths or globs");
	}
	const rawPaths = await expandDelimitedPathEntries(normalizedRawPaths, cwd);
	if (rawPaths.some(rawPath => rawPath.length === 0)) {
		throw new ToolError("Search scope entries must be non-empty paths or globs");
	}
	const strictExternalUrlRe = /^(?:https?|ftp|ws|wss):\/\//i;
	const internalRouter = InternalUrlRouter.instance();
	const resolvedPathInputs: string[] = [];
	const immutableSourcePaths = new Set<string>();
	for (const rawPath of rawPaths) {
		let externalUrl = strictExternalUrlRe.test(rawPath);
		if (!externalUrl && isReadableUrlPath(rawPath) && !hasGlobPathChars(rawPath)) {
			try {
				await fs.promises.stat(resolveToCwd(rawPath, cwd));
			} catch (err) {
				externalUrl = isMissingPath(err);
			}
		}
		if (externalUrl) {
			const resolved = opts.resolveExternalUrl ? await opts.resolveExternalUrl(rawPath) : undefined;
			if (resolved) {
				resolvedPathInputs.push(resolved.sourcePath);
				if (opts.trackImmutableSources && resolved.immutable) {
					immutableSourcePaths.add(path.resolve(resolved.sourcePath));
				}
				continue;
			}
			throw new ToolError(
				`Cannot ${internalUrlAction} external URL: ${rawPath}. Use \`read\` to fetch web content, then search the returned text.`,
			);
		}
		if (!internalRouter.canHandle(rawPath)) {
			resolvedPathInputs.push(rawPath);
			continue;
		}
		if (isSshUrl(rawPath)) {
			throw new ToolError(
				`Cannot ${internalUrlAction} a remote ssh:// path (no local file): ${rawPath}. Use \`read ${rawPath}\` to view it, or the \`search\` tool to grep remote files.`,
			);
		}
		if (hasGlobPathChars(rawPath)) {
			throw new ToolError(`Glob patterns are not supported for internal URLs: ${rawPath}`);
		}
		const resource = await internalRouter.resolve(rawPath, {
			cwd,
			settings: opts.settings,
			signal: opts.signal,
			localProtocolOptions: opts.localProtocolOptions,
			skills: opts.skills,
			pathOnly: true,
		});
		if (!resource.sourcePath) {
			throw new ToolError(`Cannot ${internalUrlAction} internal URL without a backing file: ${rawPath}`);
		}
		if (opts.trackImmutableSources && resource.immutable) {
			immutableSourcePaths.add(path.resolve(resource.sourcePath));
		}
		resolvedPathInputs.push(resource.sourcePath);
	}

	let missingPaths: string[] = [];
	let effectivePaths = resolvedPathInputs;
	if (resolvedPathInputs.length > 1) {
		const partition = await partitionExistingPaths(resolvedPathInputs, cwd, parseSearchPath);
		if (partition.valid.length === 0) {
			throw new ToolError(`Path not found: ${partition.missing.join(", ")}`);
		}
		effectivePaths = partition.valid;
		missingPaths = partition.missing;
	}

	let searchPath: string;
	let scopePath: string;
	let globFilter: string | undefined;
	let multiTargets: ResolvedSearchTarget[] | undefined;
	let exactFilePaths: string[] | undefined;
	if (effectivePaths.length === 1) {
		const parsedPath = await parseSearchPathPreferringLiteral(effectivePaths[0] ?? ".", cwd);
		searchPath = resolveToCwd(parsedPath.basePath, cwd);
		globFilter = parsedPath.glob;
		scopePath = formatPathRelativeToCwd(searchPath, cwd);
	} else {
		const multiSearchPath = await resolveExplicitSearchPaths(
			effectivePaths,
			cwd,
			undefined,
			opts.fanOutFileTargets === true,
		);
		if (!multiSearchPath) {
			throw new ToolError("`paths` must contain at least one path or glob");
		}
		searchPath = multiSearchPath.basePath;
		multiTargets = multiSearchPath.targets;
		if (opts.surfaceExactFilePaths) {
			exactFilePaths = multiSearchPath.exactFilePaths;
			globFilter = exactFilePaths || multiTargets ? undefined : multiSearchPath.glob;
		} else {
			globFilter = multiTargets ? undefined : multiSearchPath.glob;
		}
		scopePath = multiSearchPath.scopePath;
	}

	let isDirectory: boolean;
	try {
		const stat = await Bun.file(searchPath).stat();
		isDirectory = stat.isDirectory();
	} catch (err) {
		if (!isMissingPath(err)) throw err;
		const hint = opts.multipathStatHint && rawPaths.length > 1 ? opts.multipathStatHint : "";
		throw new ToolError(`Path not found: ${scopePath}${hint}`);
	}

	return {
		searchPath,
		scopePath,
		globFilter,
		isDirectory,
		multiTargets,
		exactFilePaths,
		missingPaths,
		immutableSourcePaths,
	};
}
