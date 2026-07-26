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

/**
 * The shared path-input pipeline for the `search`, `ast_grep` and `ast_edit`
 * tools: normalize the raw paths, resolve internal URLs to backing files, and
 * derive the scope those tools walk.
 *
 * WHY THIS IS NOT IN `./path-utils`, WHERE IT USED TO LIVE. It is the only thing
 * there that needs `InternalUrlRouter`, and that one import made `path-utils`
 * part of a 23-module import cycle: `path-utils` -> `internal-urls` ->
 * `skill-protocol` -> `extensibility/skills` -> `discovery` -> `builtin` ->
 * `path-utils`, with `mcp`, `lsp/utils` and `config.ts` pulled in along the way.
 * A cycle has to be instantiated as one unit, so importing ANY member pulled in
 * the whole component. Measuring each member separately gave the identical number
 * for `path-utils`, `internal-urls` and `discovery`, which is the tell: they were
 * one component wearing three names. `path-utils` is imported for
 * `expandTilde`-grade helpers all over the package, so it spread that reach very
 * widely.
 *
 * Splitting it here is also the honest boundary. `path-utils` answers questions
 * about paths; this answers "what should this tool scan", which is a different
 * job with different dependencies, and only three tools ask it.
 *
 * KEEP THIS MODULE DOWNSTREAM. It may import `./path-utils`; nothing in
 * `./path-utils` may import it back, or the cycle returns.
 */

/** Local file materialized from a readable external URL for shared tool-scope resolution. */
export interface ResolvedExternalSearchUrl {
	/** Absolute or cwd-relative file path to search. */
	sourcePath: string;
	/** True when the materialized file must not mint editable anchors. */
	immutable?: boolean;
}

export interface ToolScopeOptions {
	rawPaths: string[];
	cwd: string;
	/** Verb used in the "Cannot {action} internal URL without a backing file: …" message. */
	internalUrlAction: string;
	/** Collect absolute paths flagged immutable by their internal-URL handler. */
	trackImmutableSources?: boolean;
	/** Honor `exactFilePaths` from {@link resolveExplicitSearchPaths} (search-only). */
	surfaceExactFilePaths?: boolean;
	/** Fan plain-file entries out into per-target scans instead of folding them
	 * into a directory walk's glob union (search-only: the caller must dedupe
	 * matches from overlapping targets). */
	fanOutFileTargets?: boolean;
	/** Extra hint appended to "Path not found" when stat fails and the user supplied multiple paths. */
	multipathStatHint?: string;
	/** Calling session's settings — forwarded to the internal-URL router so caller-aware handlers (issue://, pr://) honor it. */
	settings?: unknown;
	/** Caller's abort signal — forwarded to the internal-URL router. */
	signal?: AbortSignal;
	/** Calling session's `local://` root mapping — pins resolutions to the calling session. */
	localProtocolOptions?: LocalProtocolOptions;
	/** Calling session's loaded skills — lets skill:// resolve without process-global state. */
	skills?: readonly Skill[];
	/** Materialize readable external URLs to local text files before scope derivation. */
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

/**
 * Shared path-input pipeline for `search`, `ast_grep`, and `ast_edit`:
 *  1. normalize + reject empty paths,
 *  2. resolve internal URLs through {@link InternalUrlRouter} to backing files,
 *  3. partition existing vs missing when multiple paths are supplied,
 *  4. derive a single search base path / glob, or a multi-target list,
 *  5. stat the resolved base path so callers can branch on directory vs file scope.
 */
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
	// Strict external-URL schemes. `file://` is intentionally absent: it has
	// local-path semantics (expandPath strips it downstream), so it flows through
	// the ordinary filesystem pipeline instead of the external-URL resolver.
	const strictExternalUrlRe = /^(?:https?|ftp|ws|wss):\/\//i;
	const internalRouter = InternalUrlRouter.instance();
	const resolvedPathInputs: string[] = [];
	const immutableSourcePaths = new Set<string>();
	for (const rawPath of rawPaths) {
		let externalUrl = strictExternalUrlRe.test(rawPath);
		if (!externalUrl && isReadableUrlPath(rawPath) && !hasGlobPathChars(rawPath)) {
			// Fuzzy spelling the read parser accepts (`www.host/…`, collapsed
			// `https:/host/…`). An existing local path wins over URL
			// interpretation so a directory literally named `www.foo` stays
			// searchable; only a definitive ENOENT/ENOTDIR flips to URL handling
			// (any other stat error means the path exists — let the local
			// pipeline surface it).
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
			// Resolver missing or declined (e.g. ftp/ws/wss): fail explicitly
			// instead of letting the local-path fallthrough surface a confusing
			// "Path not found" for a URL-shaped input.
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
			// Tool-scope resolution only needs `sourcePath`; skip content
			// materialization so large artifacts (or any handler that separates
			// path from content) stay searchable without OOM risk.
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
		// Only a genuinely-missing path is "Path not found". A permission error
		// (EACCES on a parent dir without +x), EIO, ELOOP, etc. must propagate
		// loudly rather than be masked as not-found — otherwise the operator hunts
		// for a path that exists. `isMissingPath` is the repo-wide owner of that split.
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
