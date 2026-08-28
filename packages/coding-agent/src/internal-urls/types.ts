/** Types for the internal URL routing system. Internal URLs (`agent://`, `artifact://`, `history://`, `issue://`, `local://`, `mcp://`, `memory://`, `veyyon://`, `pr://`, `rule://`, `skill://`, `ssh://`, and `vault://`) are resolved by tools like read, */

import type { Skill } from "../extensibility/skills";
import type { LocalProtocolOptions } from "./local-protocol";

/** Raw resource payload returned by protocol handlers. The `immutable` flag is applied by the router from {@link ProtocolHandler.immutable}, so handlers do */
export interface InternalResource {
	/** Canonical URL that was resolved */
	url: string;
	/** Resolved text content */
	content: string;
	/** MIME type: text/markdown, application/json, or text/plain */
	contentType: "text/markdown" | "application/json" | "text/plain";
	/** Content size in bytes */
	size?: number;
	/** Underlying filesystem path (for debugging, not exposed to agent) */
	sourcePath?: string;
	/** Additional notes about resolution */
	notes?: string[];
	/** True when the resolved content cannot be edited by the agent (e.g. sealed artifacts, harness docs, machine-generated memory summaries). Hashline */
	immutable?: boolean;
	/** True when the resource is a directory listing rather than file content. `search` refuses to grep such a resource when it has no `sourcePath` — a */
	isDirectory?: boolean;
}

/** A single autocomplete candidate for the host/path portion of a `scheme://` URL, produced by {@link ProtocolHandler.complete}. */
export interface UrlCompletion {
	/** The text that follows `scheme://` for this candidate (e.g. `humanizer`, `subdir/data.json`, `root`). The caller renders it as `scheme://<value>`. */
	value: string;
	/** Human-facing label for the dropdown. Defaults to {@link value}. */
	label?: string;
	/** Optional one-line description shown beside the candidate. */
	description?: string;
}

/**
 * Parsed internal URL with preserved host casing.
 */
export interface InternalUrl extends URL {
	/**
	 * Raw host segment extracted from input, preserving case.
	 */
	rawHost: string;
	/**
	 * Raw pathname extracted from input, preserving traversal markers before URL normalization.
	 */
	rawPathname?: string;
}

/** Caller-supplied context that the router threads into protocol handlers. Read tool calls `InternalUrlRouter.resolve(url, { cwd, settings, signal })` */
export interface ResolveContext {
	/** Working directory of the calling session. */
	cwd?: string;
	/** Settings of the calling session (used by `issue://`/`pr://` for cache TTLs). */
	settings?: unknown;
	/** Caller's abort signal. */
	signal?: AbortSignal;
	/** Calling session's `local://` root mapping. When present, the local-protocol handler resolves the URL against THIS session's artifacts dir instead of */
	localProtocolOptions?: LocalProtocolOptions;
	/** Calling session's loaded skills. Prefer this over process-global skill state. */
	skills?: readonly Skill[];
	/** When set, handlers that would otherwise materialize an expensive directory listing (e.g. the ssh:// handler draining a full remote `ls`) instead return */
	skipDirectoryListing?: boolean;
	/** When set, handlers that would otherwise materialize expensive content (e.g. reading a multi-MiB artifact into memory just to expose its */
	pathOnly?: boolean;
}

/** Caller context for write operations dispatched to host-owned URI handlers. Mirrors {@link ResolveContext} so handlers that share read/write state can */
export interface WriteContext {
	/** Working directory of the calling session. */
	cwd?: string;
	/** Caller's abort signal. */
	signal?: AbortSignal;
	/** Calling session's `local://` root mapping — see {@link ResolveContext.localProtocolOptions}. */
	localProtocolOptions?: LocalProtocolOptions;
}

/**
 * Handler for a specific internal URL scheme (e.g., agent://, memory://, skill://, mcp://).
 */
export interface ProtocolHandler {
	/** The scheme this handler processes (without trailing ://) */
	readonly scheme: string;
	/** Legacy scheme aliases that resolve to this same handler. Used when a scheme is renamed (e.g. `omp://` -> `veyyon://`) so links persisted in */
	readonly aliases?: readonly string[];
	/** Whether resources produced by this handler are immutable (cannot be edited by the agent). When true, callers suppress hashline anchors and */
	readonly immutable: boolean;
	/** Resolve an internal URL to its content. The router stamps the {@link InternalResource.immutable} flag from {@link ProtocolHandler.immutable}. */
	resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource>;
	/** Optional write hook. When present, the write tool dispatches `write(url, content)` to this handler instead of writing to a filesystem */
	write?(url: InternalUrl, content: string, context?: WriteContext): Promise<void>;
	/** Optional autocomplete hook. Returns candidate completions for the host/path portion of a `scheme://` URL while the user composes a prompt. */
	complete?(query?: string, context?: ResolveContext): Promise<UrlCompletion[]>;
}
