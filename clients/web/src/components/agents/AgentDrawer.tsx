import type { AgentProgressPayload, AgentSnapshot, WireSessionEntry } from "@veyyon/wire";
import { OctagonX, RotateCcw, SendHorizontal, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { GuestClient } from "../../lib/client";
import { fmtCost, fmtDuration, fmtTokens } from "../../lib/format";
import { TranscriptPoller } from "../../lib/transcript-poller";
import type { TranscriptProps } from "../transcript/Transcript";
import { Transcript } from "../transcript/Transcript";

const EMPTY_TOOLS: TranscriptProps["activeTools"] = new Map();
const POLL_MS = 1200;

export function AgentDrawer(props: {
	agent: AgentSnapshot;
	progress?: AgentProgressPayload;
	client: GuestClient;
	/** View-link guests: hide kill/revive/chat (the host rejects them anyway). */
	readOnly?: boolean;
	/** Forwarded to tool renderers so nested task cards can drill further. */
	host?: TranscriptProps["host"];
	onClose(): void;
}): ReactNode {
	const { agent, progress, client, readOnly, host, onClose } = props;
	const [entries, setEntries] = useState<readonly WireSessionEntry[]>([]);
	const [fetchError, setFetchError] = useState<string | null>(null);
	// Transcript lines the poller could not parse. Counted rather than listed:
	// the count is what tells you the transcript you are reading is incomplete,
	// and a corrupt file can produce thousands of them.
	const [droppedRows, setDroppedRows] = useState(0);
	const [draft, setDraft] = useState("");

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	// Live transcript: poll the host-side session file while the drawer is
	// open, appending parsed JSONL entries. State resets when the agent
	// changes; the interval and any in-flight reply are dropped on cleanup.
	// A frame-level host error is terminal: stop polling and show it (the
	// host replies with an unchanged cursor, so retrying would loop hot).
	useEffect(() => {
		setEntries([]);
		setFetchError(null);
		setDroppedRows(0);
		if (!agent.hasSessionFile) return;
		const poller = new TranscriptPoller(client, agent.id, {
			entries: setEntries,
			error: setFetchError,
			dropped: count => setDroppedRows(n => n + count),
		});
		poller.start(POLL_MS);
		return () => poller.stop();
	}, [agent.id, agent.hasSessionFile, client]);

	const sendChat = () => {
		const text = draft.trim();
		if (!text) return;
		client.sendAgentCmd("chat", agent.id, text);
		setDraft("");
	};

	// Live resolved model when the agent is running, else the model recorded on
	// the snapshot at launch so parked/idle agents still show what they ran on.
	const model = progress?.progress.resolvedModel ?? agent.model;

	return (
		<aside className="ag-drawer" role="dialog" aria-label={agent.displayName}>
			<header className="ag-drawer-head">
				<div className="ag-drawer-title">
					<span className="ag-drawer-name">{agent.displayName}</span>
					<span className={`ag-chip ag-chip--${agent.status}`}>{agent.status}</span>
					{model ? <span className="ag-chip ag-chip--model">{model}</span> : null}
				</div>
				<div className="ag-drawer-actions">
					{readOnly ? null : <AgentLifecycleButton agent={agent} client={client} />}
					<button type="button" className="ag-iconbtn" aria-label="close" onClick={onClose}>
						<X size={15} aria-hidden />
					</button>
				</div>
			</header>
			{progress ? <AgentStats progress={progress.progress} /> : null}
			<div className="ag-drawer-body">
				{agent.hasSessionFile ? (
					<>
						<Transcript
							compact
							entries={entries}
							stream={null}
							streamDone={false}
							activeTools={EMPTY_TOOLS}
							working={agent.status === "running" && fetchError === null}
							host={host}
						/>
						<TranscriptHealth fetchError={fetchError} droppedRows={droppedRows} />
					</>
				) : (
					<div className="ag-empty">no transcript available</div>
				)}
			</div>
			{!readOnly && (
				<form
					className="ag-chat"
					onSubmit={e => {
						e.preventDefault();
						sendChat();
					}}
				>
					<input
						className="ag-chat-input"
						value={draft}
						placeholder={`message ${agent.displayName}…`}
						onChange={e => setDraft(e.target.value)}
					/>
					<button type="submit" className="ag-iconbtn" aria-label="send" disabled={draft.trim().length === 0}>
						<SendHorizontal size={15} aria-hidden />
					</button>
				</form>
			)}
		</aside>
	);
}

/** Kill for a running agent, revive for a parked or aborted one, nothing otherwise. */
function AgentLifecycleButton(props: { agent: AgentSnapshot; client: GuestClient }): ReactNode {
	const { agent, client } = props;
	if (agent.status === "running") {
		return (
			<button type="button" className="ag-btn ag-btn--danger" onClick={() => client.sendAgentCmd("kill", agent.id)}>
				<OctagonX size={13} aria-hidden />
				kill
			</button>
		);
	}
	if (agent.status === "parked" || agent.status === "aborted") {
		return (
			<button type="button" className="ag-btn" onClick={() => client.sendAgentCmd("revive", agent.id)}>
				<RotateCcw size={13} aria-hidden />
				revive
			</button>
		);
	}
	return null;
}

function AgentStats(props: { progress: AgentProgressPayload["progress"] }): ReactNode {
	const p = props.progress;
	const ctxPct =
		p.contextTokens !== undefined && p.contextWindow
			? Math.min(100, (p.contextTokens / p.contextWindow) * 100)
			: null;
	return (
		<div className="ag-stats">
			<span className="ag-stat">
				<span className="ag-stat-label">tok</span>
				<span className="ag-stat-value">{fmtTokens(p.tokens)}</span>
			</span>
			{ctxPct !== null ? (
				<span className="ag-stat" title={`context ${fmtTokens(p.contextTokens ?? 0)}`}>
					<span className="ag-stat-label">ctx</span>
					<span className="ag-gauge">
						<span
							className={ctxPct > 80 ? "ag-gauge-fill ag-gauge-fill--warn" : "ag-gauge-fill"}
							style={{ width: `${ctxPct}%` }}
						/>
					</span>
				</span>
			) : null}
			<span className="ag-stat">
				<span className="ag-stat-label">cost</span>
				<span className="ag-stat-value">{fmtCost(p.cost)}</span>
			</span>
			<span className="ag-stat">
				<span className="ag-stat-label">tools</span>
				<span className="ag-stat-value">{p.toolCount}</span>
			</span>
			<span className="ag-stat">
				<span className="ag-stat-value">{fmtDuration(p.durationMs)}</span>
			</span>
		</div>
	);
}

/** The terminal fetch error and the count of unreadable rows, each shown only when present. */
function TranscriptHealth(props: { fetchError: string | null; droppedRows: number }): ReactNode {
	const { fetchError, droppedRows } = props;
	return (
		<>
			{fetchError !== null ? (
				<div className="ag-fetch-error" role="alert">
					transcript unavailable: {fetchError}
				</div>
			) : null}
			{droppedRows > 0 ? (
				<div className="ag-transcript-dropped" role="status">
					{droppedRows} unreadable {droppedRows === 1 ? "row" : "rows"} skipped: this transcript is incomplete
				</div>
			) : null}
		</>
	);
}
