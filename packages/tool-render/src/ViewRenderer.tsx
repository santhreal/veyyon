/**
 * Canonical tool view and execution display React renderer.
 *
 * Draws the pure ToolView contract (@veyyon/view) and projected ToolExecutionDisplay
 * (@veyyon/wire/presentation) inside collab-web and the HTML session export custom element.
 *
 * Semantic interpretation is unified in @veyyon/tool-render/view-core and consumed here
 * via ReactViewAdapter.
 */
import type {
	ToolView as CanonicalToolView,
	FramedBlockView,
	HeadedBlockView,
	NoticeView,
	StatusRowView,
	ViewLine,
	ViewSection,
	ViewSpan,
	ViewTone,
} from "@veyyon/view";
import type { ReadEntryView, ToolExecutionDisplay } from "@veyyon/wire/presentation";
import type { ReactNode } from "react";
import { Fragment } from "react";
import { AgentLink, Badge, imageIdentity, Note, nodeIdentity, Output, ResultImages, ResultText } from "./parts";
import type { ToolRenderHost, ToolResultImage, ToolResultLike } from "./types";
import { argsDigest, keyed, prettyJson, shortenPath } from "./util";
import {
	CANONICAL_SYMBOLS,
	DIFF_SIDE_CLASSES,
	renderFramedBlock,
	renderHeadedBlock,
	renderLine,
	renderNotice,
	renderSection,
	renderSpan,
	renderStatusRow,
	renderToolView,
	type SpanAttributes,
	STATUS_CLASSES,
	STATUS_LABELS,
	type StatusRowProps,
	TONE_CLASSES,
	type ViewAdapter,
} from "./view-core";

export function toneToClass(tone: ViewTone | undefined): string | undefined {
	if (!tone) return undefined;
	const vClass = TONE_CLASSES[tone];
	switch (tone) {
		case "success":
			return `${vClass} tv-ok-text`;
		case "error":
			return `${vClass} tv-err-text`;
		case "warning":
			return `${vClass} tv-warn-text`;
		case "muted":
			return `${vClass} tv-muted`;
		case "dim":
			return `${vClass} tv-faint`;
		case "accent":
			return `${vClass} tv-badge--accent`;
		case "title":
			return `${vClass} tv-name`;
		default:
			return vClass;
	}
}

export function createReactAdapter(host?: ToolRenderHost, summaryLabel?: string): ViewAdapter<ReactNode> {
	return {
		text(str: string): ReactNode {
			return str;
		},
		rawHtml(html: string): ReactNode {
			// biome-ignore lint/security/noDangerouslySetInnerHtml: `html` comes from renderMarkdownInline, whose Marked renderer escapes raw HTML tokens and drops unsafe link schemes
			return <span dangerouslySetInnerHTML={{ __html: html }} />;
		},
		fragment(children: ReactNode[]): ReactNode {
			return (
				<>
					{keyed(children, nodeIdentity).map(({ key, item }) => (
						<Fragment key={key}>{item}</Fragment>
					))}
				</>
			);
		},
		span(attrs: SpanAttributes, child: ReactNode): ReactNode {
			let inner = child;
			if (attrs.captured === true) {
				inner = <code>{child}</code>;
			}

			const classes: string[] = [];
			if (attrs.tone) {
				const tc = toneToClass(attrs.tone);
				if (tc) classes.push(tc);
			}
			if (attrs.badge === true) {
				classes.push("v-chip", "tv-badge");
				if (attrs.tone === "accent") classes.push("tv-badge--accent");
				else if (attrs.tone === "success") classes.push("tv-badge--ok");
				else if (attrs.tone === "error") classes.push("tv-badge--err");
				else if (attrs.tone === "warning") classes.push("tv-badge--warn");
			}
			if (attrs.file !== undefined) {
				classes.push("tv-path");
			}
			if (attrs.status !== undefined) {
				classes.push("v-mark", "tv-status", `tv-status--${attrs.status}`);
			}
			if (attrs.captured === true) {
				classes.push("v-captured");
			}

			const className = classes.length > 0 ? classes.join(" ") : undefined;

			return (
				<span
					className={className}
					data-symbol={attrs.symbol}
					data-status={attrs.status}
					data-file={attrs.file}
					data-file-line={attrs.fileLine}
					data-language={attrs.language}
					data-live={attrs.live ? "true" : undefined}
					aria-label={attrs.ariaLabel}
					role={attrs.role}
				>
					{inner}
				</span>
			);
		},
		emphasis(type: "bold" | "italic" | "strike", child: ReactNode): ReactNode {
			if (type === "bold") return <strong>{child}</strong>;
			if (type === "italic") return <em>{child}</em>;
			return <s>{child}</s>;
		},
		link(href: string, child: ReactNode): ReactNode {
			return (
				<a href={href} target="_blank" rel="noopener noreferrer">
					{child}
				</a>
			);
		},
		agentLink(agentId: string, child: ReactNode): ReactNode {
			return (
				<AgentLink id={agentId} host={host}>
					{child}
				</AgentLink>
			);
		},
		trailing(child: ReactNode): ReactNode {
			return <span className="v-trailing tv-trailing">{child}</span>;
		},
		resolveSymbol(symbol: string): ReactNode {
			return Object.hasOwn(CANONICAL_SYMBOLS, symbol) ? CANONICAL_SYMBOLS[symbol] : undefined;
		},
		statusRow(props: StatusRowProps<ReactNode>): ReactNode {
			let emblemMark: ReactNode = null;
			let statusMark: ReactNode = null;

			if (props.emblem) {
				const emblemTone = props.emblem.tone ? toneToClass(props.emblem.tone) : undefined;
				emblemMark = (
					<span
						className={`v-emblem tv-emblem${emblemTone ? ` ${emblemTone}` : ""}`}
						data-emblem={props.emblem.name}
					>
						{props.emblem.element}
					</span>
				);
			} else if (props.statusMark) {
				statusMark = (
					<span
						className={`v-mark tv-status tv-status--${props.statusMark.status}`}
						role="img"
						aria-label={STATUS_LABELS[props.statusMark.status]}
						data-status={props.statusMark.status}
					>
						{props.statusMark.element}
					</span>
				);
			}

			let title = props.title;
			if (
				props.inline &&
				summaryLabel &&
				title.slice(0, summaryLabel.length).toLowerCase() === summaryLabel.toLowerCase() &&
				(title.length === summaryLabel.length || title[summaryLabel.length] === " ")
			) {
				title = title.slice(summaryLabel.length).trimStart();
			}
			const titleTone = props.titleTone ? toneToClass(props.titleTone) : undefined;
			const titleNode = title ? (
				<span className={`v-title tv-name${titleTone ? ` ${titleTone}` : ""}`}>{title}</span>
			) : null;

			let descNode: ReactNode = null;
			if (props.description) {
				const descTone = props.description.tone ? toneToClass(props.description.tone) : undefined;
				const descClasses = ["v-description", "tv-desc"];
				if (descTone) descClasses.push(descTone);
				if (props.description.fits) descClasses.push("v-fits", "tv-trunc");
				const descEl = (
					<span
						className={descClasses.join(" ")}
						data-file={props.description.file}
						data-file-line={props.description.fileLine}
					>
						{props.description.text}
					</span>
				);
				if (props.description.link) {
					descNode = (
						<a href={props.description.link} target="_blank" rel="noopener noreferrer">
							{descEl}
						</a>
					);
				} else {
					descNode = descEl;
				}
			}

			let badgeNode: ReactNode = null;
			if (props.badge) {
				const badgeTone = props.badge.tone;
				const badgeSuffix =
					badgeTone === "success"
						? "ok"
						: badgeTone === "error"
							? "err"
							: badgeTone === "warning"
								? "warn"
								: "accent";
				badgeNode = <span className={`v-chip tv-badge tv-badge--${badgeSuffix}`}>{props.badge.label}</span>;
			}

			const langNode =
				props.language !== undefined ? (
					<span className="v-language tv-badge" data-language={props.language.name}>
						{props.language.name}
					</span>
				) : null;

			const metaNode =
				props.meta !== undefined && props.meta.length > 0 ? (
					<span className="v-meta tv-badges">
						{keyed(props.meta, nodeIdentity).map(({ key, item: m }) => (
							<span key={key} className="v-meta-entry">
								{m}
							</span>
						))}
					</span>
				) : null;

			if (props.inline) {
				return (
					<span className="tv-status-row-inline">
						{emblemMark || statusMark}
						{titleNode}
						{descNode}
						{badgeNode}
						{langNode}
						{metaNode}
					</span>
				);
			}

			return (
				<div
					className="v-row tv-row tv-status-row"
					data-status={props.status}
					data-live={props.live ? "true" : undefined}
				>
					{emblemMark || statusMark}
					{titleNode}
					{descNode}
					{badgeNode}
					{langNode}
					{metaNode}
				</div>
			);
		},
		textBlock(child: ReactNode): ReactNode {
			return <p className="v-text tv-text">{child}</p>;
		},
		codeSection(props): ReactNode {
			return (
				<>
					{props.lead !== undefined && <p className="v-code-lead tv-cmd-prompt">{props.lead}</p>}
					<ol
						className="v-code tv-pre"
						data-language={props.language}
						data-total-lines={props.totalLines}
						data-numbered={props.numbered ? "true" : "false"}
					>
						{props.rows.map(r => (
							<li
								key={r.index}
								className="v-code-line"
								value={r.line ?? undefined}
								data-line={r.line ?? undefined}
							>
								<code>{r.content}</code>
							</li>
						))}
					</ol>
				</>
			);
		},
		diffSection(props): ReactNode {
			return (
				<ol className="v-diff tv-diff" data-path={props.path}>
					{props.rows.map(r => {
						const sideClass = DIFF_SIDE_CLASSES[r.side];
						const tvSideClass =
							r.side === "added"
								? "tv-diff-row--add"
								: r.side === "removed"
									? "tv-diff-row--del"
									: r.side === "gap"
										? "tv-diff-row--gap"
										: "";
						return (
							<li
								key={r.index}
								className={`v-diff-line ${sideClass}${tvSideClass ? ` ${tvSideClass}` : ""}`}
								data-side={r.side}
								value={r.line ?? undefined}
								data-line={r.line ?? undefined}
							>
								<code>{r.content}</code>
							</li>
						);
					})}
				</ol>
			);
		},
		treeSection(props): ReactNode {
			return (
				<ul className="v-tree tv-tree">
					{props.rows.map(r => (
						<li
							key={r.index}
							className="v-tree-node"
							data-depth={r.depth}
							data-opens={r.opens ? "true" : "false"}
							data-last={r.last ? "true" : "false"}
							style={{ paddingLeft: `${r.depth * 1.25}rem` }}
						>
							{r.content}
						</li>
					))}
				</ul>
			);
		},
		listSection(props): ReactNode {
			return (
				<ul className="v-list tv-list">
					{keyed(props.rows, nodeIdentity).map(({ key, item: r }) => (
						<li key={key} className="v-item tv-row">
							{r}
						</li>
					))}
				</ul>
			);
		},
		proseSection(props): ReactNode {
			return (
				<>
					{props.dropped > 0 && (
						<div className="tv-faint" style={{ fontStyle: "italic", marginBottom: "0.25rem" }}>
							… {props.dropped} earlier rows elided …
						</div>
					)}
					{props.rows.map(r => (
						<div key={r.index} className={`v-line tv-line${r.clip ? " v-clip tv-trunc" : ""}`}>
							{r.content}
						</div>
					))}
				</>
			);
		},
		markdownSection(props): ReactNode {
			const tc = props.tone ? toneToClass(props.tone) : undefined;
			return (
				<div
					className={`v-markdown tv-prose${tc ? ` ${tc}` : ""}`}
					// biome-ignore lint/security/noDangerouslySetInnerHtml: `props.html` comes from renderMarkdownBlock, whose Marked renderer escapes raw HTML tokens and drops unsafe link schemes
					dangerouslySetInnerHTML={{ __html: props.html }}
				/>
			);
		},
		hiddenNote(props): ReactNode {
			if (props.count <= 0) return null;
			const noun = props.noun ? ` ${props.noun}` : "";
			return (
				<div className="v-hidden tv-expand-note tv-faint">
					⋯ {props.count} more{noun}
				</div>
			);
		},
		section(props): ReactNode {
			return (
				<section
					key={props.label ?? props.index}
					className="v-section tv-section"
					data-separator={props.separator ? "true" : undefined}
				>
					{props.label !== undefined && <h3 className="v-section-label tv-out-title">{props.label}</h3>}
					{props.body}
					{props.hidden}
				</section>
			);
		},
		framedBlock(props): ReactNode {
			return (
				<section
					className={`v-framed tv-framed${props.state ? ` ${STATUS_CLASSES[props.state]}` : ""}`}
					data-state={props.state}
					data-contents={props.contents}
					data-gutter={props.gutter ? "true" : undefined}
					data-live={props.live ? "true" : undefined}
				>
					{props.header}
					{keyed(props.sections, nodeIdentity).map(({ key, item: s }) => (
						<Fragment key={key}>{s}</Fragment>
					))}
				</section>
			);
		},
		headedBody(props): ReactNode {
			return (
				<div className="v-lines tv-lines">
					{props.dropped > 0 && (
						<div className="tv-faint" style={{ fontStyle: "italic", marginBottom: "0.25rem" }}>
							… {props.dropped} earlier rows elided …
						</div>
					)}
					{keyed(props.rows, nodeIdentity).map(({ key, item: r }) => (
						<div key={key} className="v-line tv-line">
							{r}
						</div>
					))}
				</div>
			);
		},
		headedBlock(props): ReactNode {
			return (
				<section className="v-headed tv-headed">
					{props.header}
					{props.body}
					{props.hidden}
				</section>
			);
		},
		notice(props): ReactNode {
			const noteTone =
				props.state === "error"
					? "err"
					: props.state === "warning"
						? "warn"
						: props.state === "success" || props.state === "done"
							? "ok"
							: undefined;

			return (
				<aside
					className={`v-notice tv-note${noteTone ? ` tv-note--${noteTone}` : ""} ${STATUS_CLASSES[props.state]}`}
					data-state={props.state}
					role={props.role}
				>
					{props.markElement !== undefined && (
						<span className="v-notice-mark tv-emblem" data-mark={props.mark}>
							{props.markElement}
						</span>
					)}
					<span className="v-notice-headline tv-notice-headline">{props.headline}</span>
					{props.tag !== undefined && <span className="v-notice-tag tv-badge tv-badge--accent">{props.tag}</span>}
					{props.body !== undefined && props.body.length > 0 && (
						<div className="v-notice-body tv-notice-body">
							{keyed(props.body, nodeIdentity).map(({ key, item: line }) => (
								<div key={key} className="v-line tv-line">
									{line}
								</div>
							))}
						</div>
					)}
				</aside>
			);
		},
	};
}

export function ViewSpanComponent({ span, host }: { span: ViewSpan; host?: ToolRenderHost }): ReactNode {
	return renderSpan(span, createReactAdapter(host));
}

export function ViewLineComponent({ line, host }: { line: ViewLine; host?: ToolRenderHost }): ReactNode {
	return renderLine(line, createReactAdapter(host));
}

export function StatusRowViewComponent({
	view,
	host,
	inline,
	summaryLabel,
}: {
	view: StatusRowView;
	host?: ToolRenderHost;
	inline?: boolean;
	summaryLabel?: string;
}): ReactNode {
	return renderStatusRow(view, createReactAdapter(host, summaryLabel), inline);
}

export function ViewSectionComponent({
	section,
	index,
	host,
}: {
	section: ViewSection;
	index: number;
	host?: ToolRenderHost;
}): ReactNode {
	return renderSection(section, index, createReactAdapter(host));
}

export function FramedBlockViewComponent({ view, host }: { view: FramedBlockView; host?: ToolRenderHost }): ReactNode {
	return renderFramedBlock(view, createReactAdapter(host));
}

export function HeadedBlockViewComponent({ view, host }: { view: HeadedBlockView; host?: ToolRenderHost }): ReactNode {
	return renderHeadedBlock(view, createReactAdapter(host));
}

export function NoticeViewComponent({ view, host }: { view: NoticeView; host?: ToolRenderHost }): ReactNode {
	return renderNotice(view, createReactAdapter(host));
}

export function CanonicalViewRenderer({
	view,
	host,
	inline,
}: {
	view: CanonicalToolView;
	host?: ToolRenderHost;
	inline?: boolean;
}): ReactNode {
	return renderToolView(view, createReactAdapter(host), inline);
}

export function ReadEntrySummary({ entry }: { entry: ReadEntryView }): ReactNode {
	const isMulti = entry.displayPaths && entry.displayPaths.length > 1;
	const pathDisplay = isMulti
		? entry.displayPaths!.map(path => shortenPath(path)).join(", ")
		: shortenPath(entry.path);

	return (
		<span className="tv-read-summary">
			<span className="tv-path">{pathDisplay}</span>
			{entry.correctedFrom && <Badge tone="accent">corrected from {shortenPath(entry.correctedFrom)}</Badge>}
			{entry.conflictCount !== undefined && entry.conflictCount > 0 && (
				<Badge tone="warn">
					{entry.conflictCount} conflict{entry.conflictCount === 1 ? "" : "s"}
				</Badge>
			)}
			{entry.status === "warning" && <Badge tone="warn">warning</Badge>}
			{entry.status === "error" && <Badge tone="err">error</Badge>}
			{entry.status === "notExecuted" && <Badge tone="warn">not executed</Badge>}
		</span>
	);
}

export function ToolExecutionSummary({
	name,
	args,
	display,
	host,
}: {
	name: string;
	args: Record<string, unknown>;
	result?: ToolResultLike;
	display?: ToolExecutionDisplay;
	host?: ToolRenderHost;
}): ReactNode {
	if (display?.readEntry) {
		return <ReadEntrySummary entry={display.readEntry} />;
	}

	const activeView = display?.resultView ?? display?.callView;
	if (activeView) {
		const header =
			activeView.kind === "statusRow"
				? activeView
				: activeView.kind === "headedBlock" || activeView.kind === "framedBlock"
					? activeView.header
					: undefined;
		if (header) {
			return <StatusRowViewComponent view={header} host={host} inline summaryLabel={display?.toolLabel ?? name} />;
		}
		if (activeView.kind === "notice") {
			return (
				<span className="tv-sum-notice">
					<ViewLineComponent line={activeView.headline} host={host} />
					{activeView.tag && <Badge tone="accent">{activeView.tag}</Badge>}
				</span>
			);
		}
		if (activeView.kind === "textBlock") {
			return <ViewLineComponent line={activeView.spans} host={host} />;
		}
	}

	if (display?.generic?.argsPreview) {
		return <span>{display.generic.argsPreview}</span>;
	}

	return <span>{argsDigest(args)}</span>;
}

interface WindowWithOpener {
	window?: {
		open?: (url: string, target: string, features: string) => unknown;
	};
}

function openImage(img: ToolResultImage): void {
	const g = globalThis as unknown as WindowWithOpener;
	if (typeof g.window?.open !== "function") {
		return;
	}
	let url: string;
	try {
		const bin = atob(img.data);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		url = URL.createObjectURL(new Blob([bytes], { type: img.mimeType }));
	} catch {
		return;
	}
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
	g.window.open(url, "_blank", "noopener");
}

export function ToolExecutionBody({
	args,
	result,
	display,
	host,
}: {
	name: string;
	args: Record<string, unknown>;
	result?: ToolResultLike;
	running?: boolean;
	display?: ToolExecutionDisplay;
	host?: ToolRenderHost;
}): ReactNode {
	const hasNotExecuted = display?.notExecutedReason;
	const hasMultiFile = display?.multiFileViews && display.multiFileViews.length > 0;

	const callView = display?.callView;
	const resultView = display?.resultView;
	const mergeCallAndResult = display?.policies?.mergeCallAndResult === true;
	const shouldRenderCall = callView && (!resultView || !mergeCallAndResult);

	if (!display) {
		const argText = prettyJson(args);
		return (
			<>
				{argText && argText !== "{}" && (
					<Output text={argText} lang="json" variant="code" maxLines={12} title="args" />
				)}
				<ResultImages result={result} />
				<ResultText result={result} maxLines={10} />
			</>
		);
	}

	return (
		<>
			{/* A renderer that threw is logged by the projection; the card shows the raw output below, never the exception. */}
			{hasNotExecuted && <Note tone="warn">{display.notExecutedReason}</Note>}

			{hasMultiFile && (
				<div className="tv-multi-files">
					{keyed(display.multiFileViews!, item => item.path).map(({ key, item }) => (
						<div key={key} className="tv-multi-file-item">
							<div className="tv-multi-file-header">
								<Badge tone={item.isError ? "err" : "ok"}>{shortenPath(item.path)}</Badge>
							</div>
							{item.errorNotice && <Note tone="err">{item.errorNotice}</Note>}
							{item.view && <CanonicalViewRenderer view={item.view} host={host} />}
						</div>
					))}
					{display.remainingPendingFiles !== undefined && display.remainingPendingFiles > 0 && (
						<Note tone="warn">{display.remainingPendingFiles} more files pending…</Note>
					)}
				</div>
			)}

			{display.readEntry?.contentText && (
				<Output text={display.readEntry.contentText} variant="code" maxLines={20} />
			)}

			{shouldRenderCall && <CanonicalViewRenderer view={callView} host={host} />}
			{resultView && <CanonicalViewRenderer view={resultView} host={host} />}

			{display.generic?.outputText && (
				<Output
					text={display.generic.outputText}
					lang={display.generic.isJson ? "json" : undefined}
					variant={display.generic.isJson ? "code" : "plain"}
					maxLines={14}
				/>
			)}

			{display.images && display.images.length > 0 && display.images.every(img => Boolean(img.data)) ? (
				<div className="tv-imgs">
					{keyed(display.images, imageIdentity).map(({ key, item: img }, i) => (
						<button
							key={key}
							type="button"
							style={{ all: "unset", display: "inline-flex" }}
							onClick={() =>
								openImage({
									type: "image",
									data: img.data ?? "",
									mimeType: img.mimeType ?? "image/png",
								})
							}
							aria-label={`Open tool result image ${i + 1}`}
						>
							<img
								className="tv-img"
								src={`data:${img.mimeType};base64,${img.data}`}
								alt={`tool result ${i + 1}`}
							/>
						</button>
					))}
				</div>
			) : (
				<ResultImages result={result} />
			)}

			{!resultView && !display.generic?.outputText && <ResultText result={result} maxLines={10} />}
		</>
	);
}
