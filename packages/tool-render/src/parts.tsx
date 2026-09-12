/**
 * Shared UI primitives for tool renderers. Every renderer composes these
 * instead of inventing new CSS — see tool-render.css for the `tv-` classes.
 */
import type { ReactNode } from "react";
import { isValidElement, useMemo, useState } from "react";
import type { ToolRenderHost, ToolResultImage, ToolResultLike } from "./types";
import { getHljs, keyed, replaceTabs, resultImagesOf, resultTextOf, shortenPath, stripAnsi } from "./util";

export type Tone = "accent" | "ok" | "err" | "warn";

/**
 * Whether a node renders to nothing. `null`/`undefined` are absent values, `""`
 * is an empty string child, and `false` is the residue of a `cond && <X/>` guard.
 * Components use this to collapse rather than emit empty chrome.
 */
function isEmptyNode(node: ReactNode): boolean {
	return node == null || node === "" || node === false;
}

/**
 * What a node is, for keying a sibling list of nodes that carry no ids: its text for a string or
 * number, its own key for a keyed element, else the element type with a string child. Equal
 * siblings are told apart by `keyed`.
 */
export function nodeIdentity(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (isValidElement<{ children?: ReactNode }>(node)) {
		if (node.key !== null) return node.key;
		const type = typeof node.type === "string" ? node.type : typeof node.type === "function" ? node.type.name : "";
		const child = node.props.children;
		return typeof child === "string" || typeof child === "number" ? `${type}:${child}` : type;
	}
	return String(node);
}

/** A compact fingerprint of an image's bytes: its type, size and trailing base64 characters. */
export function imageIdentity(img: { data?: string; mimeType?: string }): string {
	const data = img.data ?? "";
	return `${img.mimeType ?? ""}:${data.length}:${data.slice(-16)}`;
}

/** Inline chip. Renders nothing for empty content. */
export function Badge({ children, tone }: { children: ReactNode; tone?: Tone }): ReactNode {
	if (isEmptyNode(children)) return null;
	return <span className={`tv-badge${tone ? ` tv-badge--${tone}` : ""}`}>{children}</span>;
}

/** Chip row; falsy items are skipped. Usable inline (summaries) and in bodies. */
export function Badges({ items }: { items: ReadonlyArray<ReactNode> }): ReactNode {
	const visible = items.filter(item => !isEmptyNode(item));
	if (visible.length === 0) return null;
	return (
		<span className="tv-badges">
			{keyed(visible, nodeIdentity).map(({ key, item }) => (
				<Badge key={key}>{item}</Badge>
			))}
		</span>
	);
}

/** File path with optional `:start-end` line range or raw selector suffix. */
export function PathText({
	path,
	from,
	to,
	sel,
}: {
	path: string;
	from?: number | null;
	to?: number | null;
	sel?: string | null;
}): ReactNode {
	let range = "";
	if (from != null || to != null) {
		const start = from ?? 1;
		range = to != null ? `:${start}-${to}` : `:${start}`;
	}
	return (
		<span className="tv-path">
			{shortenPath(path)}
			{range && <span className="tv-lines">{range}</span>}
			{sel && <span className="tv-lines">:{sel}</span>}
		</span>
	);
}

/** Key/value grid. */
export function KvGrid({ children }: { children: ReactNode }): ReactNode {
	return <div className="tv-kv">{children}</div>;
}

export function Kv({ k, children }: { k: ReactNode; children: ReactNode }): ReactNode {
	if (isEmptyNode(children)) return null;
	return (
		<>
			<span className="tv-kv-key">{k}</span>
			<span className="tv-kv-val">{children}</span>
		</>
	);
}

/** Field in a KvGrid that renders an InvalidArg fallback when a present raw arg resolves empty. */
export function ArgKv({ k, raw, val }: { k: string; raw: unknown; val: ReactNode }): ReactNode {
	if (raw === undefined) return null;
	return <Kv k={k}>{isEmptyNode(val) ? <InvalidArg what={k} /> : val}</Kv>;
}

function useHighlight(code: string, lang: string | null | undefined): string | null {
	return useMemo(() => {
		if (!lang) return null;
		const hljs = getHljs();
		if (!hljs) return null;
		try {
			if (!hljs.getLanguage(lang)) return null;
			return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
		} catch {
			return null;
		}
	}, [code, lang]);
}

export interface OutputProps {
	text: string;
	/** Lines shown before collapsing behind a "more" affordance. */
	maxLines?: number;
	/** highlight.js language (only applied when the host exposes hljs). */
	lang?: string | null;
	/** Render in error color. */
	error?: boolean;
	/** "code": horizontal scroll, inset bg. "plain": soft-wrapped. */
	variant?: "code" | "plain";
	/** Uppercase mini-title above the block. */
	title?: string;
	/** Drop the inset background (inline in flow). */
	bare?: boolean;
}

/**
 * Expandable text block — the workhorse for command output, file previews,
 * search results. Tabs are widened, ANSI escapes stripped.
 */
export function Output({ text, maxLines = 10, lang, error, variant = "plain", title, bare }: OutputProps): ReactNode {
	const [expanded, setExpanded] = useState(false);
	const clean = useMemo(() => replaceTabs(stripAnsi(text)).replace(/\n+$/, ""), [text]);
	const lines = useMemo(() => clean.split("\n"), [clean]);
	const collapsible = lines.length > maxLines + 1;
	const shown = collapsible && !expanded ? lines.slice(0, maxLines).join("\n") : clean;
	const html = useHighlight(shown, error ? null : lang);
	const classes = ["tv-pre"];
	if (variant === "plain") classes.push("tv-pre--wrap");
	if (error) classes.push("tv-pre--error");
	if (bare) classes.push("tv-pre--bare");
	return (
		<div className="tv-out">
			{title && <div className="tv-out-title">{title}</div>}
			{html !== null ? (
				// biome-ignore lint/security/noDangerouslySetInnerHtml: `html` is highlight.js markup built from `shown`, which hljs escapes before wrapping in its span classes
				<pre className={classes.join(" ")} dangerouslySetInnerHTML={{ __html: html }} />
			) : (
				<pre className={classes.join(" ")}>{shown}</pre>
			)}
			{collapsible && (
				<button type="button" className="tv-expand" onClick={() => setExpanded(v => !v)}>
					{expanded ? "collapse" : `⋯ ${lines.length - maxLines} more lines`}
				</button>
			)}
		</div>
	);
}

/** Source-code block: inset background, no soft wrap, optional title chip. */
export function CodeBlock({
	code,
	lang,
	title,
	maxLines = 14,
}: {
	code: string;
	lang?: string | null;
	title?: string;
	maxLines?: number;
}): ReactNode {
	if (!code) return null;
	return <Output text={code} lang={lang} maxLines={maxLines} variant="code" title={title} />;
}

/**
 * Result text of a tool result, styled for success or error automatically.
 * Renders nothing when the result is absent or has no text.
 */
export function ResultText({
	result,
	maxLines = 10,
	lang,
	variant,
	title,
}: {
	result: ToolResultLike | undefined;
	maxLines?: number;
	lang?: string | null;
	variant?: "code" | "plain";
	title?: string;
}): ReactNode {
	const text = resultTextOf(result).trim();
	if (!text) return null;
	return (
		<Output
			text={text}
			maxLines={maxLines}
			lang={result?.isError ? null : lang}
			error={result?.isError === true}
			variant={variant ?? (lang ? "code" : "plain")}
			title={title}
		/>
	);
}

/**
 * Open a URL in a new tab, reaching `window` through `globalThis` instead of
 * naming it.
 *
 * This package is host-agnostic source that other programs typecheck, and not all
 * of them declare the DOM library. `scripts/tool-renderer-coverage.test.ts` checks
 * every tool the agent can call against this package's registry, so its program
 * holds this file next to `packages/coding-agent`, and those two cannot share one
 * `lib`: with DOM, the agent's node code collides with the DOM's `Response`,
 * `Headers` and `NodeList`. Everything else here (`atob`, `Blob`, `URL`,
 * `setTimeout`) exists in both libraries, so a bare `window` was the one name that
 * broke the build over there. See the note in `tsconfig.tools.json`.
 *
 * A missing opener throws rather than returning quietly. `ResultImages` renders in
 * a browser, so there is no case where this is absent and the click still did what
 * the reader asked; swallowing it would leave a button that looks live and does
 * nothing.
 */
function openInNewTab(url: string): void {
	type Opener = { open?: (url: string, target: string, features: string) => unknown };
	const browserWindow = (globalThis as { window?: Opener }).window;
	if (typeof browserWindow?.open !== "function") {
		throw new Error("tool-render: cannot open an image, this host has no window.open");
	}
	browserWindow.open(url, "_blank", "noopener");
}

function openImage(img: ToolResultImage): void {
	let url: string;
	try {
		const bin = atob(img.data);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		url = URL.createObjectURL(new Blob([bytes], { type: img.mimeType }));
	} catch {
		// Undecodable base64 is the one failure worth passing over: the broken
		// thumbnail beside this button already shows it, and there is nothing to
		// open. The try covers decoding ONLY, so a blocked popup or a host without
		// `window` still surfaces instead of being swallowed with it.
		return;
	}
	// Scheduled before the open so a throw below cannot strand the object URL.
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
	openInNewTab(url);
}

/** Thumbnails for every image block in a result; click opens full size. */
export function ResultImages({ result }: { result: ToolResultLike | undefined }): ReactNode {
	const images = resultImagesOf(result);
	if (images.length === 0) return null;
	return (
		<div className="tv-imgs">
			{keyed(images, imageIdentity).map(({ key, item: img }, i) => (
				<button
					key={key}
					type="button"
					style={{ all: "unset", display: "inline-flex" }}
					onClick={() => openImage(img)}
					aria-label={`Open tool result image ${i + 1}`}
				>
					<img className="tv-img" src={`data:${img.mimeType};base64,${img.data}`} alt={`tool result ${i + 1}`} />
				</button>
			))}
		</div>
	);
}

/** Callout block. */
export function Note({ tone, children }: { tone?: "err" | "warn" | "ok"; children: ReactNode }): ReactNode {
	if (isEmptyNode(children)) return null;
	return <div className={`tv-note${tone ? ` tv-note--${tone}` : ""}`}>{children}</div>;
}

/** Labeled row inside a `.tv-list`. */
export function Row({ k, children }: { k?: ReactNode; children: ReactNode }): ReactNode {
	return (
		<div className="tv-row">
			{k != null && k !== "" && <span className="tv-row-key">{k}</span>}
			<span className="tv-row-val">{children}</span>
		</div>
	);
}

/** Marker for arguments that arrived with the wrong JSON type. */
export function InvalidArg({ what }: { what?: string }): ReactNode {
	return <span className="tv-err-text">[invalid {what ?? "arg"}]</span>;
}

export function MissingPathsNote({ paths }: { paths: readonly string[] }): ReactNode {
	if (paths.length === 0) return null;
	return <Note tone="warn">skipped missing: {paths.map(p => shortenPath(p)).join(", ")}</Note>;
}

export function ParseErrorsOutput({
	errors,
	title,
	variant = "plain",
}: {
	errors: readonly string[];
	title: string;
	variant?: "code" | "plain";
}): ReactNode {
	if (errors.length === 0) return null;
	return <Output text={errors.join("\n")} maxLines={6} title={title} variant={variant} />;
}

/**
 * Unified-diff-ish block: `+` rows added, `-` rows removed, `@@` hunk headers
 * faint, blank rows render as `…` gaps (non-contiguous regions).
 */
export function DiffBlock({ diff, maxLines = 80 }: { diff: string; maxLines?: number }): ReactNode {
	const [expanded, setExpanded] = useState(false);
	const lines = useMemo(() => replaceTabs(stripAnsi(diff)).replace(/\n+$/, "").split("\n"), [diff]);
	const collapsible = lines.length > maxLines + 1;
	const shown = collapsible && !expanded ? lines.slice(0, maxLines) : lines;
	return (
		<div className="tv-out">
			<div className="tv-diff">
				{keyed(shown, line => line).map(({ key, item: line }) => {
					let cls = "";
					if (line.trim().length === 0) cls = "--gap";
					else if (line.startsWith("+")) cls = "--add";
					else if (line.startsWith("-")) cls = "--del";
					else if (line.startsWith("@@")) cls = "--hunk";
					return (
						<div key={key} className={`tv-diff-row${cls ? ` tv-diff-row${cls}` : ""}`}>
							{line.trim().length === 0 ? "…" : line}
						</div>
					);
				})}
			</div>
			{collapsible && (
				<button type="button" className="tv-expand" onClick={() => setExpanded(v => !v)}>
					{expanded ? "collapse" : `⋯ ${lines.length - maxLines} more lines`}
				</button>
			)}
		</div>
	);
}

/**
 * Agent id chip. Becomes a drill-down button when the host can open that
 * agent's sub-session; otherwise renders as a plain accent badge.
 */
export function AgentLink({
	id,
	host,
	children,
}: {
	id: string;
	host?: ToolRenderHost;
	children?: ReactNode;
}): ReactNode {
	const clickable = host?.openAgent !== undefined && (host.hasAgent === undefined || host.hasAgent(id));
	if (!clickable) return <Badge tone="accent">{children ?? id}</Badge>;
	return (
		<button type="button" className="tv-badge tv-badge--accent tv-agent-link" onClick={() => host.openAgent?.(id)}>
			{children ?? id}
			<span className="tv-agent-link-arrow" aria-hidden="true">
				{" ↗"}
			</span>
		</button>
	);
}
