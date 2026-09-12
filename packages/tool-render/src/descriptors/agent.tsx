import { stripRecommendedSuffix } from "@veyyon/wire";
import type { ReactNode } from "react";
import { AgentLink, Badge, Badges, InvalidArg, Kv, KvGrid, Note, Output, ResultText, Row, type Tone } from "../parts";
import type { ToolDescriptor, ToolRenderHost, ToolRenderProps } from "../types";
import { argsDigest, detailsRecord, finiteNumber, isRecord, keyed, normalizeWs, str, strList, truncate } from "../util";

// ============================================================================
// task
// ============================================================================

const MISSING_YIELD_PREFIX_RE = /^SYSTEM WARNING: (?:Agent|Subagent) exited without calling yield tool/;

interface TaskItemView {
	id: string | null;
	description: string | null;
	assignment: string | null;
	isolated: boolean;
}

function taskItems(args: Record<string, unknown>): TaskItemView[] {
	const raw = args.tasks;
	if (Array.isArray(raw)) {
		const items: TaskItemView[] = [];
		for (const entry of raw) {
			if (!isRecord(entry)) continue;
			items.push({
				id: str(entry.id),
				description: str(entry.description),
				assignment: str(entry.assignment),
				isolated: entry.isolated === true,
			});
		}
		return items;
	}
	const flat: TaskItemView = {
		id: str(args.id),
		description: str(args.description),
		assignment: str(args.assignment),
		isolated: args.isolated === true,
	};
	return flat.id || flat.description || flat.assignment ? [flat] : [];
}

function taskIdLabel(id: string): string {
	return id.includes(".") ? id.split(".").join(">") : id;
}

function fmtDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
	return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function fmtCount(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function resultStatus(res: Record<string, unknown>): { label: string; tone: "ok" | "err" | "warn" } {
	if (res.aborted === true) return { label: "aborted", tone: "err" };
	if (finiteNumber(res.exitCode) === 0) {
		return str(res.error) ? { label: "merge failed", tone: "warn" } : { label: "done", tone: "ok" };
	}
	return { label: "failed", tone: "err" };
}

function TaskSummary({ args }: ToolRenderProps): ReactNode {
	const agent = str(args.agent);
	const resume = str(args.resume);
	const tasks = taskItems(args);
	const first = tasks.length > 0 ? tasks[0] : null;
	const label = first ? (first.description ?? first.id) : null;
	return (
		<>
			{agent && <Badge tone="accent">{agent}</Badge>}
			{!agent && resume && <Badge>resume {resume}</Badge>}
			{label && <span className="tv-muted">{truncate(normalizeWs(label), 72)}</span>}
			{tasks.length > 1 && <Badge>{tasks.length} tasks</Badge>}
		</>
	);
}

function AgentResult({ res, host }: { res: Record<string, unknown>; host?: ToolRenderHost }): ReactNode {
	const { label, tone } = resultStatus(res);
	const id = str(res.id) ?? "agent";
	const description = str(res.description);
	const stats: string[] = [];
	const tokens = finiteNumber(res.tokens);
	if (tokens) stats.push(`${fmtCount(tokens)} tok`);
	const requests = finiteNumber(res.requests);
	if (requests) stats.push(`${requests} req`);
	const durationMs = finiteNumber(res.durationMs);
	if (durationMs != null) stats.push(fmtDuration(durationMs));
	const model = str(res.resolvedModel);
	if (model) stats.push(model);

	let output = str(res.output) ?? "";
	let warning: string | null = null;
	const nl = output.indexOf("\n");
	const firstLine = (nl === -1 ? output : output.slice(0, nl)).trim();
	if (MISSING_YIELD_PREFIX_RE.test(firstLine)) {
		warning = firstLine;
		output = nl === -1 ? "" : output.slice(nl + 1).replace(/^\s*\n+/, "");
	}
	const error = str(res.error);
	const aborted = res.aborted === true;
	const abortReason = str(res.abortReason);
	const patchPath = str(res.patchPath);
	const branchName = str(res.branchName);
	return (
		<>
			<Row
				k={
					<AgentLink id={id} host={host}>
						{taskIdLabel(id)}
					</AgentLink>
				}
			>
				<Badge tone={tone}>{label}</Badge> {res.truncated === true && <Badge tone="warn">truncated</Badge>}{" "}
				{description && <span>{truncate(normalizeWs(description), 96)}</span>}{" "}
				{stats.length > 0 && <span className="tv-faint">{stats.join(" · ")}</span>}
			</Row>
			{warning && <Note tone="warn">{warning}</Note>}
			{aborted && abortReason && <Note tone="err">{abortReason}</Note>}
			{output.trim() !== "" && <Output text={output} maxLines={6} error={tone === "err"} />}
			{error && !aborted && error !== abortReason && <Note tone={tone === "warn" ? "warn" : "err"}>{error}</Note>}
			{patchPath && <div className="tv-faint">patch: {patchPath}</div>}
			{!patchPath && branchName && <div className="tv-faint">branch: {branchName}</div>}
		</>
	);
}

function AgentProgressRow({ p, host }: { p: Record<string, unknown>; host?: ToolRenderHost }): ReactNode {
	const status = str(p.status) ?? "running";
	const tone =
		status === "completed"
			? ("ok" as const)
			: status === "failed" || status === "aborted"
				? ("err" as const)
				: status === "running"
					? ("accent" as const)
					: undefined;
	const id = str(p.id) ?? "agent";
	const description = str(p.description);
	const intent = str(p.lastIntent) ?? str(p.currentTool);
	const bits: string[] = [];
	const toolCount = finiteNumber(p.toolCount);
	if (toolCount) bits.push(`${toolCount} tools`);
	const tokens = finiteNumber(p.tokens);
	if (tokens) bits.push(`${fmtCount(tokens)} tok`);
	const durationMs = finiteNumber(p.durationMs);
	if (durationMs) bits.push(fmtDuration(durationMs));
	return (
		<Row
			k={
				<AgentLink id={id} host={host}>
					{taskIdLabel(id)}
				</AgentLink>
			}
		>
			<Badge tone={tone}>{status}</Badge> {description && <span>{truncate(normalizeWs(description), 96)}</span>}{" "}
			{intent && <span className="tv-muted">{truncate(normalizeWs(intent), 64)}</span>}{" "}
			{bits.length > 0 && <span className="tv-faint">{bits.join(" · ")}</span>}
		</Row>
	);
}

function TaskBody({ args, result, host }: ToolRenderProps): ReactNode {
	const resume = str(args.resume);
	const context = str(args.context);
	const tasks = taskItems(args);
	const details = detailsRecord(result);
	const results = details && Array.isArray(details.results) ? details.results.filter(isRecord) : [];
	const progress = details && Array.isArray(details.progress) ? details.progress.filter(isRecord) : [];
	const showProgress = results.length === 0 && progress.length > 0;

	let footer: ReactNode = null;
	if (results.length > 0) {
		let ok = 0;
		let mergeFailed = 0;
		let aborted = 0;
		let failed = 0;
		for (const res of results) {
			const { label } = resultStatus(res);
			if (label === "done") ok++;
			else if (label === "merge failed") mergeFailed++;
			else if (label === "aborted") aborted++;
			else failed++;
		}
		const total = details ? finiteNumber(details.totalDurationMs) : null;
		footer = (
			<Row>
				{ok > 0 && <Badge tone="ok">{ok} succeeded</Badge>}{" "}
				{mergeFailed > 0 && <Badge tone="warn">{mergeFailed} merge failed</Badge>}{" "}
				{failed > 0 && <Badge tone="err">{failed} failed</Badge>}{" "}
				{aborted > 0 && <Badge tone="err">{aborted} aborted</Badge>}{" "}
				{total != null && <span className="tv-faint">{fmtDuration(total)}</span>}
			</Row>
		);
	}

	const ordered = results
		.slice()
		.sort(
			(a, b) =>
				(finiteNumber(a.durationMs) ?? 0) - (finiteNumber(b.durationMs) ?? 0) ||
				(finiteNumber(a.index) ?? 0) - (finiteNumber(b.index) ?? 0),
		);

	return (
		<>
			{resume && <Badge>resume {resume}</Badge>}
			{context && <Output text={context} maxLines={4} title="context" />}
			{tasks.length > 0 && (
				<div className="tv-list">
					{tasks.map((t, i) => (
						<div key={t.id ?? i}>
							<Row
								k={
									t.id ? (
										<AgentLink id={t.id} host={host}>
											{taskIdLabel(t.id)}
										</AgentLink>
									) : (
										<Badge tone="accent">{`#${i + 1}`}</Badge>
									)
								}
							>
								{t.isolated && <Badge>isolated</Badge>}{" "}
								{t.description && <span>{truncate(normalizeWs(t.description), 120)}</span>}
							</Row>
							{t.assignment && <Output text={t.assignment} maxLines={6} title="assignment" />}
						</div>
					))}
				</div>
			)}
			{ordered.length > 0 && (
				<div className="tv-list">
					{ordered.map((res, i) => (
						<AgentResult key={str(res.id) ?? i} res={res} host={host} />
					))}
					{footer}
				</div>
			)}
			{showProgress && (
				<div className="tv-list">
					{progress.map((p, i) => (
						<AgentProgressRow key={str(p.id) ?? i} p={p} host={host} />
					))}
				</div>
			)}
			{ordered.length === 0 && !showProgress && <ResultText result={result} maxLines={12} />}
		</>
	);
}

// ============================================================================
// ask
// ============================================================================

interface AskOption {
	label: string;
	description?: string;
}

interface AskQuestion {
	id: string;
	question: string;
	options: AskOption[];
	multi: boolean;
	recommended?: number;
}

interface AskAnswer {
	id?: string;
	selectedOptions: string[];
	customInput?: string;
	timedOut?: boolean;
}

function normalizeOptions(raw: unknown): AskOption[] {
	if (!Array.isArray(raw)) return [];
	const out: AskOption[] = [];
	for (const entry of raw) {
		if (typeof entry === "string") {
			out.push({ label: entry });
			continue;
		}
		if (!isRecord(entry)) continue;
		const label = str(entry.label);
		if (label === null) continue;
		const description = str(entry.description);
		out.push(description !== null ? { label, description } : { label });
	}
	return out;
}

function normalizeQuestions(raw: unknown): AskQuestion[] {
	if (typeof raw === "string") {
		try {
			raw = JSON.parse(raw);
		} catch {
			return [];
		}
	}
	if (!Array.isArray(raw)) return [];
	const out: AskQuestion[] = [];
	for (const entry of raw) {
		if (!isRecord(entry)) continue;
		out.push({
			id: str(entry.id) ?? "?",
			question: str(entry.question) ?? "",
			options: normalizeOptions(entry.options),
			multi: entry.multi === true,
			recommended: finiteNumber(entry.recommended) ?? undefined,
		});
	}
	return out;
}

function questionsOf(args: Record<string, unknown>): AskQuestion[] {
	const questions = normalizeQuestions(args.questions);
	if (questions.length > 0) return questions;
	const question = str(args.question);
	if (question === null) return [];
	return [
		{
			id: "?",
			question,
			options: normalizeOptions(args.options),
			multi: args.multi === true,
			recommended: finiteNumber(args.recommended) ?? undefined,
		},
	];
}

function answerOf(rec: Record<string, unknown>): AskAnswer {
	const selectedOptions: string[] = [];
	if (Array.isArray(rec.selectedOptions)) {
		for (const entry of rec.selectedOptions) {
			const label = str(entry);
			if (label !== null) selectedOptions.push(stripRecommendedSuffix(label));
		}
	}
	return {
		id: str(rec.id) ?? undefined,
		selectedOptions,
		customInput: str(rec.customInput) ?? undefined,
		timedOut: rec.timedOut === true,
	};
}

function answersOf(details: Record<string, unknown> | null): AskAnswer[] | null {
	if (!details) return null;
	if (Array.isArray(details.results)) {
		const out: AskAnswer[] = [];
		for (const entry of details.results) if (isRecord(entry)) out.push(answerOf(entry));
		return out.length > 0 ? out : null;
	}
	if (details.question !== undefined || details.selectedOptions !== undefined || details.customInput !== undefined) {
		return [answerOf(details)];
	}
	return null;
}

function questionsFromDetails(details: Record<string, unknown>): AskQuestion[] {
	const source = Array.isArray(details.results) ? details.results : [details];
	const out: AskQuestion[] = [];
	for (const entry of source) {
		if (!isRecord(entry)) continue;
		const question = str(entry.question);
		if (question === null) continue;
		out.push({
			id: str(entry.id) ?? "?",
			question,
			options: normalizeOptions(entry.options),
			multi: entry.multi === true,
		});
	}
	return out;
}

function AskSummary({ args }: ToolRenderProps): ReactNode {
	const questions = questionsOf(args);
	const first = questions[0];
	if (!first) return <InvalidArg what="questions" />;
	return (
		<>
			<span>{truncate(normalizeWs(first.question), 70)}</span>
			{questions.length > 1 && <Badge>{questions.length} questions</Badge>}
		</>
	);
}

function QuestionBlock({ q, answer }: { q: AskQuestion; answer: AskAnswer | undefined }): ReactNode {
	const selected = new Set(answer?.selectedOptions);
	return (
		<div className="tv-list">
			<Row>
				{q.id !== "?" && <span className="tv-faint">[{q.id}] </span>}
				{q.question ? <span>{q.question}</span> : <InvalidArg what="question" />}
				{q.multi && <Badge>multi</Badge>}
			</Row>
			{keyed(q.options, opt => opt.label).map(({ key, item: opt }, i) => {
				const isSelected = selected.has(stripRecommendedSuffix(opt.label));
				const marker = q.multi ? (isSelected ? "■" : "□") : isSelected ? "●" : "○";
				return (
					<Row key={key} k={<span className={isSelected ? "tv-ok-text" : undefined}>{marker}</span>}>
						<span className={answer && !isSelected ? "tv-muted" : undefined}>{opt.label}</span>
						{i === q.recommended && <Badge tone="accent">recommended</Badge>}
						{opt.description && <span className="tv-muted"> — {opt.description}</span>}
					</Row>
				);
			})}
			{answer?.customInput !== undefined && (
				<Row k="✎">
					<span className="tv-ok-text">{answer.customInput}</span>
				</Row>
			)}
			{answer && answer.selectedOptions.length === 0 && answer.customInput === undefined && (
				<Row k="—">
					<span className="tv-warn-text">no selection</span>
				</Row>
			)}
			{answer?.timedOut && <Note tone="warn">auto-selected after timeout — not a user choice</Note>}
		</div>
	);
}

function AskBody({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const answers = answersOf(details);
	let questions = questionsOf(args);
	if (questions.length === 0 && details) questions = questionsFromDetails(details);
	return (
		<>
			{keyed(questions, q => q.id).map(({ key, item: q }, i) => {
				const answer = answers ? (answers.find(a => a.id !== undefined && a.id === q.id) ?? answers[i]) : undefined;
				return <QuestionBlock key={key} q={q} answer={answer} />;
			})}
			{questions.length === 0 && !result && <InvalidArg what="questions" />}
			{!answers && <ResultText result={result} maxLines={10} />}
		</>
	);
}

// ============================================================================
// irc
// ============================================================================

interface IrcReceipt {
	to: string;
	outcome: string;
	error?: string;
}

interface IrcMsg {
	from: string;
	body: string;
	replyTo?: string;
}

interface IrcPeer {
	id: string;
	kind: string;
	status: string;
	parentId?: string;
	unread: number;
}

function parseReceipts(value: unknown): IrcReceipt[] {
	if (!Array.isArray(value)) return [];
	const out: IrcReceipt[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		const to = str(item.to);
		const outcome = str(item.outcome);
		if (to === null || outcome === null) continue;
		out.push({ to, outcome, error: str(item.error) ?? undefined });
	}
	return out;
}

function parseMsg(value: unknown): IrcMsg | null {
	if (!isRecord(value)) return null;
	const from = str(value.from);
	const body = str(value.body);
	if (from === null || body === null) return null;
	return { from, body, replyTo: str(value.replyTo) ?? undefined };
}

function parseInbox(value: unknown): IrcMsg[] {
	if (!Array.isArray(value)) return [];
	const out: IrcMsg[] = [];
	for (const item of value) {
		const msg = parseMsg(item);
		if (msg) out.push(msg);
	}
	return out;
}

const PEER_STATUS_ORDER: Record<string, number> = { running: 0, idle: 1, parked: 2 };

function parsePeers(value: unknown): IrcPeer[] {
	if (!Array.isArray(value)) return [];
	const out: IrcPeer[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		const id = str(item.id);
		if (id === null) continue;
		out.push({
			id,
			kind: str(item.kind) ?? "?",
			status: str(item.status) ?? "?",
			parentId: str(item.parentId) ?? undefined,
			unread: typeof item.unread === "number" && Number.isFinite(item.unread) ? item.unread : 0,
		});
	}
	return out.sort((a, b) => (PEER_STATUS_ORDER[a.status] ?? 9) - (PEER_STATUS_ORDER[b.status] ?? 9));
}

function outcomeTone(outcome: string): Tone | undefined {
	switch (outcome) {
		case "woken":
			return "ok";
		case "revived":
			return "warn";
		case "injected":
			return "accent";
		case "failed":
			return "err";
		default:
			return undefined;
	}
}

function peerStatusTone(status: string): Tone | undefined {
	switch (status) {
		case "running":
			return "accent";
		case "idle":
			return "ok";
		case "parked":
			return undefined;
		default:
			return "err";
	}
}

function IrcSummary({ args, result }: ToolRenderProps): ReactNode {
	const op = str(args.op) ?? "?";
	const d = detailsRecord(result);
	const opBadge = <Badge tone={result?.isError ? "err" : op === "send" ? "accent" : undefined}>{op}</Badge>;
	if (op === "send") {
		const to = str(args.to);
		const message = str(args.message);
		return (
			<>
				{opBadge} {to && <span className="tv-pattern">→ {to}</span>}{" "}
				{message && <span className="tv-muted">{truncate(normalizeWs(message), 80)}</span>}
			</>
		);
	}
	if (op === "wait") {
		const waited = d ? parseMsg(d.waited) : null;
		if (waited) {
			return (
				<>
					{opBadge} <span className="tv-pattern">← {waited.from}</span>{" "}
					<span className="tv-muted">{truncate(normalizeWs(waited.body), 80)}</span>
				</>
			);
		}
		const from = str(args.from);
		return (
			<>
				{opBadge} <span className="tv-pattern">← {from ?? "anyone"}</span>
				{d?.waited === null && (
					<>
						{" "}
						<Badge tone="warn">timed out</Badge>
					</>
				)}
			</>
		);
	}
	if (op === "inbox") {
		const inbox = d ? parseInbox(d.inbox) : [];
		return (
			<>
				{opBadge} {args.peek === true && <Badge>peek</Badge>}{" "}
				{d && (
					<span className="tv-muted">
						{inbox.length === 0 ? "empty" : `${inbox.length} ${inbox.length === 1 ? "message" : "messages"}`}
					</span>
				)}
			</>
		);
	}
	if (op === "list") {
		const peers = d ? parsePeers(d.peers) : [];
		let unread = 0;
		for (const peer of peers) unread += peer.unread;
		return (
			<>
				{opBadge} {d && <span className="tv-muted">{peers.length === 1 ? "1 peer" : `${peers.length} peers`}</span>}
				{unread > 0 && (
					<>
						{" "}
						<Badge tone="warn">{unread} unread</Badge>
					</>
				)}
			</>
		);
	}
	return opBadge;
}

function IrcBody({ args, result }: ToolRenderProps): ReactNode {
	const op = str(args.op);
	const to = str(args.to);
	const from = str(args.from);
	const message = str(args.message);
	const d = detailsRecord(result);
	const receipts = parseReceipts(d?.receipts);
	const waited = d ? parseMsg(d.waited) : null;
	const timedOut = d ? d.waited === null : false;
	const inbox = parseInbox(d?.inbox);
	const peers = parsePeers(d?.peers);
	const structured = receipts.length > 0 || waited !== null || timedOut || inbox.length > 0 || peers.length > 0;
	return (
		<>
			<Badges
				items={[
					op ?? "?",
					to && `to ${to}`,
					op === "wait" && from && `from ${from}`,
					to === "all" && "broadcast",
					args.await === true && "await reply",
					str(args.replyTo) && "reply",
					args.peek === true && "peek",
				]}
			/>
			{message && <Note>{message}</Note>}
			{receipts.length > 0 && (
				<div className="tv-list">
					{keyed(receipts, receipt => receipt.to).map(({ key, item: receipt }) => (
						<Row key={key} k={receipt.to}>
							<Badge tone={outcomeTone(receipt.outcome)}>{receipt.outcome}</Badge>
							{receipt.error && <span className="tv-err-text"> — {receipt.error}</span>}
						</Row>
					))}
				</div>
			)}
			{waited && (
				<div className="tv-list">
					<Row k={`← ${waited.from}`}>
						{waited.body}
						{waited.replyTo && (
							<>
								{" "}
								<Badge>reply</Badge>
							</>
						)}
					</Row>
				</div>
			)}
			{timedOut && <Note tone="warn">No reply yet — they may answer later; check inbox or wait again.</Note>}
			{inbox.length > 0 && (
				<div className="tv-list">
					{keyed(inbox, msg => `${msg.from}\u001f${msg.body}`).map(({ key, item: msg }) => (
						<Row key={key} k={msg.from}>
							{msg.body}
							{msg.replyTo && (
								<>
									{" "}
									<Badge>reply</Badge>
								</>
							)}
						</Row>
					))}
				</div>
			)}
			{peers.length > 0 && (
				<div className="tv-list">
					{peers.map(peer => (
						<Row key={peer.id} k={peer.id}>
							<Badge tone={peerStatusTone(peer.status)}>{peer.status}</Badge>{" "}
							<span className="tv-faint">
								{peer.parentId ? `${peer.kind} · of ${peer.parentId}` : peer.kind}
							</span>
							{peer.unread > 0 && (
								<>
									{" "}
									<Badge tone="warn">{peer.unread} unread</Badge>
								</>
							)}
						</Row>
					))}
				</div>
			)}
			{(!structured || result?.isError) && <ResultText result={result} maxLines={8} />}
		</>
	);
}

// ============================================================================
// vibe_*
// ============================================================================

interface ScreenView {
	id: string;
	cli: string | null;
	state: string | null;
	model: string | null;
	turns: number | null;
	queued: number | null;
	turnMessage: string | null;
	currentTool: string | null;
	lastIntent: string | null;
	trace: string[];
	outputTail: string[];
	lastActivity: string | null;
}

function screensOf(details: Record<string, unknown> | null): ScreenView[] {
	if (!details || !Array.isArray(details.screens)) return [];
	const out: ScreenView[] = [];
	for (const raw of details.screens) {
		if (!isRecord(raw)) continue;
		const id = str(raw.id);
		if (id === null) continue;
		out.push({
			id,
			cli: str(raw.cli),
			state: str(raw.state),
			model: str(raw.model),
			turns: finiteNumber(raw.turns),
			queued: finiteNumber(raw.queued),
			turnMessage: str(raw.turnMessage),
			currentTool: str(raw.currentTool),
			lastIntent: str(raw.lastIntent),
			trace: strList(raw.trace),
			outputTail: strList(raw.outputTail),
			lastActivity: str(raw.lastActivity),
		});
	}
	return out;
}

function vibeStateTone(state: string | null): Tone | undefined {
	if (state === "running" || state === "starting") return "accent";
	if (state === "dead") return "err";
	if (state === "idle") return "ok";
	return undefined;
}

function onAir(screens: ScreenView[]): number {
	return screens.filter(screen => screen.state === "running" || screen.state === "starting").length;
}

function targetIds(args: Record<string, unknown>): string[] {
	const single = str(args.session);
	if (single !== null) return [single];
	return strList(args.sessions);
}

function sendModeLabel(mode: string | null): { text: string; tone: Tone } | null {
	if (mode === "turn") return { text: "turn started", tone: "ok" };
	if (mode === "steered") return { text: "steered mid-turn", tone: "accent" };
	if (mode === "queued") return { text: "queued for the next turn", tone: "warn" };
	return null;
}

function opSummary(op: string, args: Record<string, unknown>, details: Record<string, unknown> | null): ReactNode {
	switch (op) {
		case "vibe_spawn": {
			const spawned = isRecord(details?.spawned) ? details.spawned : null;
			const cli = str(spawned?.cli) ?? str(args.cli);
			const id = str(spawned?.id) ?? str(args.name);
			const prompt = str(args.prompt);
			return (
				<>
					{cli && <Badge tone="accent">{cli}</Badge>}
					{id && <span className="tv-row-key">{id}</span>}
					{prompt && <span>{truncate(normalizeWs(prompt), 88)}</span>}
				</>
			);
		}
		case "vibe_send": {
			const send = isRecord(details?.send) ? details.send : null;
			const id = str(send?.id) ?? str(args.session);
			const mode = sendModeLabel(str(send?.mode));
			const text = str(args.message);
			return (
				<>
					{id && <span className="tv-row-key">{id}</span>}
					{mode && <Badge tone={mode.tone}>{mode.text}</Badge>}
					{text && <span>{truncate(normalizeWs(text), 88)}</span>}
				</>
			);
		}
		case "vibe_wait": {
			const wait = isRecord(details?.wait) ? details.wait : null;
			const settled = Array.isArray(wait?.settled) ? wait.settled.length : 0;
			const stillRunning = Array.isArray(wait?.stillRunning) ? wait.stillRunning.length : 0;
			const watching = targetIds(args);
			return (
				<Badges
					items={[
						wait?.waiting === true ? (
							<Badge key="watching" tone="accent">
								watching
							</Badge>
						) : null,
						settled > 0 ? (
							<Badge key="settled" tone="ok">
								{`${settled} settled`}
							</Badge>
						) : null,
						stillRunning > 0 ? (
							<Badge key="running" tone="accent">
								{`${stillRunning} still running`}
							</Badge>
						) : null,
						wait?.timedOut === true ? (
							<Badge key="timedOut" tone="warn">
								timed out
							</Badge>
						) : null,
						wait === null && watching.length > 0 ? <Badge key="targets">{watching.join(", ")}</Badge> : null,
					].filter(item => item !== null)}
				/>
			);
		}
		case "vibe_kill": {
			const killed = isRecord(details?.killed) ? details.killed : null;
			const id = str(killed?.id) ?? str(args.session);
			return (
				<>
					{id && <span className="tv-row-key">{id}</span>}
					{killed?.cancelledTurn === true && <Badge tone="warn">in-flight turn cancelled</Badge>}
				</>
			);
		}
		default:
			return null;
	}
}

function VibeSummary({ name, args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const screens = screensOf(details);
	const running = onAir(screens);
	return (
		<>
			{opSummary(name, args, details)}
			{screens.length > 0 && (
				<Badge tone={running > 0 ? "accent" : undefined}>
					{running > 0
						? `${running}/${screens.length} on air`
						: `${screens.length} worker${screens.length === 1 ? "" : "s"}`}
				</Badge>
			)}
		</>
	);
}

function Screen({ screen, settledStatus }: { screen: ScreenView; settledStatus?: string }): ReactNode {
	const activity = screen.currentTool ?? screen.lastIntent ?? screen.lastActivity;
	return (
		<div className="tv-list">
			<Row k={screen.id}>
				<Badges
					items={[
						screen.cli ? (
							<Badge key="cli" tone="accent">
								{screen.cli}
							</Badge>
						) : null,
						screen.state ? (
							<Badge key="state" tone={vibeStateTone(screen.state)}>
								{screen.state}
							</Badge>
						) : null,
						settledStatus ? (
							<Badge key="settled" tone={settledStatus === "completed" ? "ok" : "err"}>
								{settledStatus}
							</Badge>
						) : null,
						screen.model ? <Badge key="model">{screen.model}</Badge> : null,
						screen.turns !== null ? (
							<Badge key="turns">{`${screen.turns} turn${screen.turns === 1 ? "" : "s"}`}</Badge>
						) : null,
						screen.queued ? (
							<Badge key="queued" tone="warn">
								{`${screen.queued} queued`}
							</Badge>
						) : null,
					].filter(item => item !== null)}
				/>
			</Row>
			{screen.turnMessage && <Row k="turn">{truncate(normalizeWs(screen.turnMessage), 120)}</Row>}
			{activity && <Row k="doing">{truncate(normalizeWs(activity), 120)}</Row>}
			{screen.trace.length > 0 && <Output title="trace" text={screen.trace.join("\n")} maxLines={6} />}
			{screen.outputTail.length > 0 && <Output title="output" text={screen.outputTail.join("\n")} maxLines={8} />}
		</div>
	);
}

function settledStatuses(details: Record<string, unknown> | null): Map<string, string> {
	const wait = isRecord(details?.wait) ? details.wait : null;
	const settled = Array.isArray(wait?.settled) ? wait.settled : [];
	const byId = new Map<string, string>();
	for (const entry of settled) {
		if (!isRecord(entry)) continue;
		const id = str(entry.id);
		const status = str(entry.status);
		if (id !== null && status !== null) byId.set(id, status);
	}
	return byId;
}

function VibeBody({ name, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const screens = screensOf(details);
	const wait = isRecord(details?.wait) ? details.wait : null;
	const statuses = settledStatuses(details);
	const stillRunning = strList(wait?.stillRunning);

	return (
		<>
			{wait?.timedOut === true && (
				<Note tone="warn">
					{stillRunning.length > 0
						? `The wait timed out with ${stillRunning.join(", ")} still running.`
						: "The wait timed out."}
				</Note>
			)}
			{name === "vibe_list" && screens.length === 0 && <Note>No worker sessions.</Note>}
			{screens.map(screen => (
				<Screen key={screen.id} screen={screen} settledStatus={statuses.get(screen.id)} />
			))}
			{screens.length === 0 && <ResultText result={result} />}
		</>
	);
}

// ============================================================================
// goal
// ============================================================================

interface GoalView {
	objective: string;
	status: string;
	tokenBudget: number | null;
	tokensUsed: number | null;
	timeUsedSeconds: number | null;
}

function goalOf(details: Record<string, unknown> | null): GoalView | null {
	const g = details?.goal;
	if (!isRecord(g)) return null;
	const objective = str(g.objective);
	const status = str(g.status);
	if (objective === null || status === null) return null;
	return {
		objective,
		status,
		tokenBudget: finiteNumber(g.tokenBudget),
		tokensUsed: finiteNumber(g.tokensUsed),
		timeUsedSeconds: finiteNumber(g.timeUsedSeconds),
	};
}

function describeGoalOp(op: string | null): string {
	switch (op) {
		case "create":
			return "set";
		case "get":
			return "check";
		default:
			return op ?? "?";
	}
}

function goalStatusTone(status: string): Tone | undefined {
	switch (status) {
		case "complete":
			return "ok";
		case "budget-limited":
			return "warn";
		case "paused":
		case "dropped":
			return undefined;
		default:
			return "accent";
	}
}

function fmtNum(n: number): string {
	if (n < 1_000) return `${n}`;
	const scaled = (v: number): string => {
		const s = v < 10 ? v.toFixed(1) : `${Math.round(v)}`;
		return s.endsWith(".0") ? s.slice(0, -2) : s;
	};
	if (n < 1_000_000) return `${scaled(n / 1_000)}K`;
	if (n < 1_000_000_000) return `${scaled(n / 1_000_000)}M`;
	return `${scaled(n / 1_000_000_000)}B`;
}

function fmtSeconds(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	if (s < 60) return `${s}s`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h}h`;
	return `${Math.round(h / 24)}d`;
}

function tokensLine(goal: GoalView): string {
	const used = fmtNum(goal.tokensUsed ?? 0);
	if (goal.tokenBudget === null) return `${used} tokens`;
	const left = Math.max(0, goal.tokenBudget - (goal.tokensUsed ?? 0));
	return `${used} / ${fmtNum(goal.tokenBudget)} tokens (${fmtNum(left)} left)`;
}

function GoalSummary({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const goal = goalOf(details);
	const op = str(details?.op) ?? str(args.op);
	const objective = goal?.objective ?? str(args.objective);
	const budget = finiteNumber(args.token_budget);
	return (
		<>
			{op === null && args.op !== undefined ? <InvalidArg what="op" /> : <span>{describeGoalOp(op)}</span>}
			{goal && <Badge tone={goalStatusTone(goal.status)}>{goal.status}</Badge>}
			{objective !== null && objective.trim() !== "" && (
				<span className="tv-muted">“{truncate(normalizeWs(objective), 64)}”</span>
			)}
			{budget !== null && <span className="tv-faint">budget {fmtNum(budget)}</span>}
		</>
	);
}

function GoalBody({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const goal = goalOf(details);
	const op = str(details?.op) ?? str(args.op);
	const objective = goal?.objective ?? str(args.objective);
	const budgetArg = finiteNumber(args.token_budget);
	const report = str(details?.completionBudgetReport);
	const hasTokens = goal !== null && (goal.tokensUsed !== null || goal.tokenBudget !== null);
	return (
		<>
			<KvGrid>
				<Kv k="op">{describeGoalOp(op)}</Kv>
				{goal && (
					<Kv k="status">
						<Badge tone={goalStatusTone(goal.status)}>{goal.status}</Badge>
					</Kv>
				)}
				{objective !== null && objective.trim() !== "" && <Kv k="objective">{objective.trim()}</Kv>}
				{hasTokens && goal ? (
					<Kv k="tokens">{tokensLine(goal)}</Kv>
				) : (
					budgetArg !== null && <Kv k="budget">{fmtNum(budgetArg)} tokens</Kv>
				)}
				{goal !== null && goal.timeUsedSeconds !== null && goal.timeUsedSeconds > 0 && (
					<Kv k="elapsed">{fmtSeconds(goal.timeUsedSeconds)}</Kv>
				)}
			</KvGrid>
			{details !== null && goal === null && !result?.isError && <Note tone="warn">no active goal</Note>}
			{report !== null && report !== "" && <Output text={report} title="Report" maxLines={12} />}
			{(goal === null || result?.isError) && <ResultText result={result} maxLines={10} />}
		</>
	);
}

// ============================================================================
// yield
// ============================================================================

function YieldSummary({ args }: ToolRenderProps): ReactNode {
	return <span>{argsDigest(args.data ?? args)}</span>;
}

function YieldBody({ args, result }: ToolRenderProps): ReactNode {
	let dataText = "";
	if (args.data !== undefined) {
		try {
			dataText = JSON.stringify(args.data, null, 2) ?? "";
		} catch {
			dataText = String(args.data);
		}
	}
	return (
		<>
			{dataText && <Output text={dataText} lang="json" variant="code" maxLines={12} />}
			<ResultText result={result} maxLines={6} />
		</>
	);
}

// ============================================================================
// Exports
// ============================================================================

export const agentDescriptors: readonly ToolDescriptor[] = [
	{ name: "task", Summary: TaskSummary, Body: TaskBody },
	{ name: "ask", Summary: AskSummary, Body: AskBody },
	{ name: "irc", Summary: IrcSummary, Body: IrcBody },
	{ name: "vibe_spawn", Summary: VibeSummary, Body: VibeBody },
	{ name: "vibe_send", Summary: VibeSummary, Body: VibeBody },
	{ name: "vibe_wait", Summary: VibeSummary, Body: VibeBody },
	{ name: "vibe_kill", Summary: VibeSummary, Body: VibeBody },
	{ name: "vibe_list", Summary: VibeSummary, Body: VibeBody },
	{ name: "goal", Summary: GoalSummary, Body: GoalBody },
	{ name: "yield", Summary: YieldSummary, Body: YieldBody },
];
