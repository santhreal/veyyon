/**
 * Tool card chrome + per-tool dispatch. Works in the collab-web app and inside
 * the `<vey-tool-view>` web component embedded in HTML session exports.
 */
import { INTENT_FIELD } from "@veyyon/wire";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { PartialTail } from "./partial-tail";
import { resolveToolRenderer } from "./registry";
import type { ToolRenderHost, ToolRenderProps, ToolResultLike } from "./types";
import { isRecord } from "./util";
import "./tool-render.css";

export interface ToolViewProps {
	name: string;
	args?: unknown;
	result?: ToolResultLike;
	/** Tool is still executing (live collab view). */
	running?: boolean;
	/** Model-provided intent (`i`), shown atop the body. */
	intent?: string;
	/** Streaming partial output tail while running. */
	partial?: string;
	defaultOpen?: boolean;
	/** Host capabilities (sub-session drill-down, …). */
	host?: ToolRenderHost;
}

function normalizeArgs(raw: unknown): { args: Record<string, unknown>; intent: string | undefined } {
	if (!isRecord(raw)) return { args: {}, intent: undefined };
	const intent = typeof raw[INTENT_FIELD] === "string" ? (raw[INTENT_FIELD] as string).trim() : undefined;
	if (!(INTENT_FIELD in raw)) return { args: raw, intent };
	const args: Record<string, unknown> = {};
	for (const k in raw) {
		if (k !== INTENT_FIELD) args[k] = raw[k];
	}
	return { args, intent };
}

export function ToolView(props: ToolViewProps): ReactNode {
	const [open, setOpen] = useState(props.defaultOpen ?? false);
	const { args, intent: argIntent } = normalizeArgs(props.args);
	const intent = props.intent?.trim() || argIntent;
	const renderer = resolveToolRenderer(props.name);
	const renderProps: ToolRenderProps = {
		name: props.name,
		args,
		result: props.result,
		running: props.running,
		host: props.host,
	};

	const isError = props.result?.isError === true;
	const status = props.running ? "run" : isError ? "err" : props.result ? "ok" : "pending";
	// The tail is stripped incrementally: each arrival costs what arrived, not
	// the whole buffer stripped again. Feeding the same value twice is a no-op,
	// so a re-render adds nothing.
	const tail = useRef<PartialTail | null>(null);
	tail.current ??= new PartialTail();
	const streamed = props.running === true && !props.result ? props.partial : undefined;
	if (typeof streamed === "string") tail.current.push(streamed);
	const partial = typeof streamed === "string" ? tail.current.text : "";

	return (
		<div className={`tv-card${isError ? " tv-card--error" : ""}`}>
			<button
				type="button"
				className="tv-head"
				aria-expanded={open}
				onClick={() => setOpen(v => !v)}
				title={intent || undefined}
			>
				{status === "run" ? (
					<span className="tv-spin" aria-label="running" />
				) : (
					<span className={`tv-status tv-status--${status}`} aria-hidden="true" />
				)}
				<span className="tv-name">{props.name}</span>
				<span className="tv-sum">
					<renderer.Summary {...renderProps} />
				</span>
				<span className="tv-chev" aria-hidden="true" />
			</button>
			{open && (
				<div className="tv-body">
					{intent && <div className="tv-intent">{intent}</div>}
					{renderer.Body ? <renderer.Body {...renderProps} /> : null}
				</div>
			)}
			{partial && <pre className="tv-partial">{partial}</pre>}
		</div>
	);
}
