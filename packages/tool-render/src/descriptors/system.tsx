import { classifyGithubCheckRun } from "@veyyon/utils/github-check-run";
import { stripTaskResultEnvelope } from "@veyyon/wire/task-result";
import type { ReactNode } from "react";
import type { Tone } from "../parts";
import {
	Badge,
	Badges,
	CodeBlock,
	InvalidArg,
	Kv,
	KvGrid,
	Note,
	Output,
	PathText,
	ResultImages,
	ResultText,
	Row,
} from "../parts";
import type { ToolDescriptor, ToolRenderProps, ToolResultLike } from "../types";
import {
	argsDigest,
	detailsRecord,
	display,
	finiteNumber,
	isRecord,
	keyed,
	normalizeWs,
	replaceTabs,
	resultTextOf,
	shortenPath,
	str,
	strList,
	truncate,
} from "../util";

// ============================================================================
// bash
// ============================================================================
/** Values safe to show unquoted in a `NAME=value` shell prefix. */
const SHELL_SAFE = /^[\w@%+=:,./-]+$/;

/** Footer appended by the bash tool when long output was spilled to an artifact. */
const ARTIFACT_NOTICE = /\[raw output: artifact:\/\/([\w-]+)\]/;

function envPrefix(env: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const k in env) {
		const v = display(env[k]);
		parts.push(`${k}=${SHELL_SAFE.test(v) ? v : JSON.stringify(v)}`);
	}
	return parts.join(" ");
}

interface BashAsyncDetails {
	state: string;
	jobId: string | null;
}

function asyncDetailsOf(details: Record<string, unknown> | null): BashAsyncDetails | null {
	if (!details || !isRecord(details.async)) return null;
	const state = str(details.async.state);
	return state ? { state, jobId: str(details.async.jobId) } : null;
}

function BashSummary({ args, result }: ToolRenderProps): ReactNode {
	const command = args.command === undefined ? "…" : str(args.command);
	if (command === null) return <InvalidArg what="command" />;
	const text = truncate(normalizeWs(command) || "…", 80);
	return result?.isError ? <span className="tv-err-text">{text}</span> : <span>{text}</span>;
}

function BashBody({ args, result }: ToolRenderProps): ReactNode {
	const command = args.command === undefined ? "…" : str(args.command);
	const prefix = isRecord(args.env) ? envPrefix(args.env) : "";
	const cwd = str(args.cwd);
	const head = finiteNumber(args.head);
	const tail = finiteNumber(args.tail);

	const details = detailsRecord(result);
	const exitCode = finiteNumber(details?.exitCode);
	const wallTimeMs = finiteNumber(details?.wallTimeMs);
	const timeoutSeconds = finiteNumber(args.timeout) ?? finiteNumber(details?.timeoutSeconds);
	const requestedTimeoutSeconds = finiteNumber(details?.requestedTimeoutSeconds);
	const job = asyncDetailsOf(details);
	const artifactId = ARTIFACT_NOTICE.exec(resultTextOf(result))?.[1] ?? null;

	const stats: string[] = [];
	if (wallTimeMs !== null) {
		stats.push(wallTimeMs < 1000 ? `wall ${Math.round(wallTimeMs)}ms` : `wall ${(wallTimeMs / 1000).toFixed(1)}s`);
	}
	if (requestedTimeoutSeconds !== null && requestedTimeoutSeconds !== timeoutSeconds) {
		stats.push(`requested timeout ${requestedTimeoutSeconds}s clamped`);
	}
	if (job?.jobId) stats.push(`job ${job.jobId}`);
	if (artifactId) stats.push(`artifact ${artifactId}`);

	return (
		<>
			<div className="tv-cmd">
				<span className="tv-cmd-prompt">$</span>
				<span className="tv-cmd-text">
					{prefix && <span className="tv-cmd-env">{`${prefix} `}</span>}
					{command ?? <InvalidArg what="command" />}
				</span>
			</div>
			<Badges
				items={[
					cwd && <Badge>cwd={shortenPath(cwd)}</Badge>,
					timeoutSeconds !== null && <Badge>timeout={timeoutSeconds}s</Badge>,
					args.pty === true && <Badge tone="accent">pty</Badge>,
					!job && args.async === true && <Badge tone="accent">async</Badge>,
					head !== null && <Badge>head={head}</Badge>,
					tail !== null && <Badge>tail={tail}</Badge>,
					exitCode !== null && <Badge tone="err">exit {exitCode}</Badge>,
					job && (
						<Badge tone={job.state === "failed" ? "err" : job.state === "running" ? "accent" : "ok"}>
							async {job.state}
						</Badge>
					),
				]}
			/>
			<ResultImages result={result} />
			<ResultText result={result} maxLines={12} />
			{stats.length > 0 && <Row>{stats.join(" · ")}</Row>}
		</>
	);
}

// ============================================================================
// ssh
// ============================================================================

/** Subset of the coding-agent `TruncationMeta` we surface. */
interface SshTruncationInfo {
	totalLines: number | null;
	outputLines: number | null;
	artifactId: string | null;
}

function sshTruncationOf(result: ToolRenderProps["result"]): SshTruncationInfo | null {
	const meta = detailsRecord(result)?.meta;
	if (!isRecord(meta) || !isRecord(meta.truncation)) return null;
	const t = meta.truncation;
	return {
		totalLines: finiteNumber(t.totalLines),
		outputLines: finiteNumber(t.outputLines),
		artifactId: str(t.artifactId),
	};
}

function stripSshTruncationNotice(text: string): string {
	const trimmed = text.trimEnd();
	if (!trimmed.endsWith("]")) return trimmed;
	const idx = trimmed.lastIndexOf("\n[Showing ");
	if (idx >= 0) return trimmed.slice(0, idx).trimEnd();
	return trimmed.startsWith("[Showing ") && !trimmed.includes("\n") ? "" : trimmed;
}

function SshSummary({ args }: ToolRenderProps): ReactNode {
	const host = str(args.host);
	const command = str(args.command);
	return (
		<>
			<Badge tone="accent">{host ?? "…"}</Badge>{" "}
			{command !== null
				? truncate(normalizeWs(command), 80)
				: args.command !== undefined && <InvalidArg what="command" />}
		</>
	);
}

function SshBody({ args, result }: ToolRenderProps): ReactNode {
	const host = str(args.host);
	const command = str(args.command);
	const cwd = str(args.cwd);
	const timeout = finiteNumber(args.timeout);
	const trunc = sshTruncationOf(result);
	const stripped =
		trunc !== null && result?.isError !== true ? stripSshTruncationNotice(resultTextOf(result).trim()) : null;
	return (
		<>
			<Badges
				items={[
					host !== null ? (
						<Badge key="host" tone="accent">
							{host}
						</Badge>
					) : (
						<InvalidArg key="host" what="host" />
					),
					cwd !== null && <Badge>cwd {shortenPath(cwd)}</Badge>,
					timeout !== null && <Badge>timeout {timeout}s</Badge>,
				]}
			/>
			{command !== null ? (
				<div className="tv-cmd">
					<span className="tv-cmd-prompt">$</span>
					<span className="tv-cmd-text">{replaceTabs(command)}</span>
				</div>
			) : (
				<InvalidArg what="command" />
			)}
			{stripped !== null ? (
				stripped !== "" && <Output text={stripped} maxLines={12} />
			) : (
				<ResultText result={result} maxLines={12} />
			)}
			{trunc !== null && (
				<Note tone="warn">
					Output truncated
					{trunc.outputLines !== null &&
						trunc.totalLines !== null &&
						` — showing ${trunc.outputLines} of ${trunc.totalLines} lines`}
					{trunc.artifactId !== null && ` · full output at artifact://${trunc.artifactId}`}
				</Note>
			)}
		</>
	);
}

// ============================================================================
// launch
// ============================================================================

interface Daemon {
	name: string | null;
	id: string | null;
	state: string | null;
	pid: number | null;
	exitCode: number | null;
	signal: string | null;
	exitReason: string | null;
	restartCount: number | null;
}

function daemonOf(value: unknown): Daemon | null {
	if (!isRecord(value)) return null;
	return {
		name: str(value.name),
		id: str(value.id),
		state: str(value.state),
		pid: finiteNumber(value.pid),
		exitCode: finiteNumber(value.exitCode),
		signal: str(value.signal),
		exitReason: str(value.exitReason),
		restartCount: finiteNumber(value.restartCount),
	};
}

function stateTone(state: string | null, isError: boolean | undefined): "ok" | "warn" | "err" | undefined {
	if (isError || state === "failed") return "err";
	if (state === "ready" || state === "running") return "ok";
	if (state === "exited") return "warn";
	return undefined;
}

function exitPhrase(daemon: Daemon): string | null {
	if (daemon.signal) return `killed by ${daemon.signal}`;
	if (daemon.exitCode !== null) return daemon.exitCode === 0 ? "exited cleanly" : `exit ${daemon.exitCode}`;
	return null;
}

function firstDaemon(details: Record<string, unknown> | null): Daemon | null {
	if (!details) return null;
	const single = daemonOf(details.daemon);
	if (single) return single;
	const list = Array.isArray(details.daemons) ? details.daemons : [];
	return list.length === 1 ? daemonOf(list[0]) : null;
}

function daemonList(details: Record<string, unknown> | null): Daemon[] {
	if (!details || !Array.isArray(details.daemons)) return [];
	return details.daemons.map(daemonOf).filter((entry): entry is Daemon => entry !== null);
}

function LaunchSummary({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const op = (details ? str(details.op) : null) ?? str(args.op);
	const daemons = daemonList(details);
	const daemon = firstDaemon(details);
	const name = daemon?.name ?? str(args.name);
	const timedOut = details?.timedOut === true;
	return (
		<>
			<Badge tone={result?.isError ? "err" : "accent"}>{op ?? "launch"}</Badge> {name && <span>{name}</span>}
			{daemon?.state && (
				<>
					{" "}
					<Badge tone={stateTone(daemon.state, result?.isError)}>{daemon.state}</Badge>
				</>
			)}
			{timedOut && (
				<>
					{" "}
					<Badge tone="warn">timed out</Badge>
				</>
			)}
			{!daemon && daemons.length > 0 && (
				<span> {daemons.length === 1 ? "1 daemon" : `${daemons.length} daemons`}</span>
			)}
		</>
	);
}

function DaemonRows({ daemons, isError }: { daemons: Daemon[]; isError: boolean | undefined }): ReactNode {
	return (
		<div className="tv-list">
			{daemons.map((daemon, index) => {
				const exit = exitPhrase(daemon);
				return (
					<Row key={daemon.id ?? daemon.name ?? index}>
						<Badge tone={stateTone(daemon.state, isError)}>{daemon.state ?? "?"}</Badge>{" "}
						{daemon.name && <span>{daemon.name}</span>}
						{daemon.pid !== null && <span className="tv-faint"> pid {daemon.pid}</span>}
						{exit && <span className="tv-faint"> {exit}</span>}
						{daemon.restartCount !== null && daemon.restartCount > 0 && (
							<span className="tv-faint"> restarted {daemon.restartCount}x</span>
						)}
					</Row>
				);
			})}
		</div>
	);
}

function terminalText(details: Record<string, unknown> | null): string | null {
	if (!details || !Array.isArray(details.terminalRows)) return null;
	const rows = details.terminalRows.filter((row): row is string => typeof row === "string");
	return rows.length > 0 ? rows.join("\n") : null;
}

function argvText(value: unknown): string {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").join(" ") : "";
}

function LaunchBody({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const op = (details ? str(details.op) : null) ?? str(args.op);
	const daemons = daemonList(details);
	const daemon = firstDaemon(details);
	const spec = details && isRecord(details.spec) ? details.spec : null;
	const matched = details ? str(details.matched) : null;
	const logs = terminalText(details);
	const exit = daemon ? exitPhrase(daemon) : null;
	return (
		<>
			<Badges
				items={[
					<Badge key="op" tone={result?.isError ? "err" : "accent"}>
						{op ?? "launch"}
					</Badge>,
					daemon?.state && (
						<Badge key="state" tone={stateTone(daemon.state, result?.isError)}>
							{daemon.state}
						</Badge>
					),
					details?.timedOut === true && (
						<Badge key="timeout" tone="warn">
							timed out
						</Badge>
					),
				]}
			/>
			{daemon && (
				<KvGrid>
					{daemon.name && <Kv k="daemon">{daemon.name}</Kv>}
					{daemon.pid !== null && <Kv k="pid">{String(daemon.pid)}</Kv>}
					{exit && <Kv k="exit">{exit}</Kv>}
					{daemon.exitReason && <Kv k="reason">{truncate(normalizeWs(daemon.exitReason), 200)}</Kv>}
					{daemon.restartCount !== null && daemon.restartCount > 0 && (
						<Kv k="restarts">{String(daemon.restartCount)}</Kv>
					)}
					{matched && <Kv k="matched">{truncate(normalizeWs(matched), 200)}</Kv>}
				</KvGrid>
			)}
			{!daemon && daemons.length > 0 && <DaemonRows daemons={daemons} isError={result?.isError} />}
			{spec && (
				<KvGrid>
					{str(spec.application) && (
						<Kv k="command">{truncate(normalizeWs(`${str(spec.application)} ${argvText(spec.args)}`), 200)}</Kv>
					)}
					{str(spec.cwd) && <Kv k="cwd">{str(spec.cwd)}</Kv>}
				</KvGrid>
			)}
			{logs && <Output text={logs} maxLines={20} title="output" />}
			<ResultText result={result} maxLines={8} />
		</>
	);
}

// ============================================================================
// job
// ============================================================================

interface JobSnapshotLike {
	id: string;
	type: string;
	status: string;
	label: string;
	durationMs: number;
	resultText: string;
	errorText: string;
}

interface CancelOutcomeLike {
	id: string;
	status: string;
}

function pollIds(args: Record<string, unknown>): string[] {
	const poll = strList(args.poll);
	if (poll.length > 0) return poll;
	const jobs = strList(args.jobs);
	return jobs.length > 0 ? jobs : strList(args.jobIds);
}

function cancelIds(args: Record<string, unknown>): string[] {
	const cancel = strList(args.cancel);
	if (cancel.length > 0) return cancel;
	const single = str(args.jobId);
	return single ? [single] : [];
}

function groupLabel(verb: string, ids: string[]): string {
	return ids.length <= 2 ? `${verb} ${ids.join(", ")}` : `${verb} ${ids.length}`;
}

function jobOf(value: unknown): JobSnapshotLike | null {
	if (!isRecord(value)) return null;
	const id = str(value.id);
	if (!id) return null;
	return {
		id,
		type: str(value.type) ?? "",
		status: str(value.status) ?? "",
		label: str(value.label) ?? "",
		durationMs: finiteNumber(value.durationMs) ?? 0,
		resultText: str(value.resultText) ?? "",
		errorText: str(value.errorText) ?? "",
	};
}

function jobsOf(details: Record<string, unknown> | null): JobSnapshotLike[] {
	const raw = details?.jobs;
	if (!Array.isArray(raw)) return [];
	const out: JobSnapshotLike[] = [];
	for (const item of raw) {
		const job = jobOf(item);
		if (job) out.push(job);
	}
	return out;
}

function cancelOutcomesOf(details: Record<string, unknown> | null): CancelOutcomeLike[] {
	const raw = details?.cancelled;
	if (!Array.isArray(raw)) return [];
	const out: CancelOutcomeLike[] = [];
	for (const item of raw) {
		if (!isRecord(item)) continue;
		const id = str(item.id);
		if (id) out.push({ id, status: str(item.status) ?? "" });
	}
	return out;
}

function jobStatusTone(status: string): Tone | undefined {
	switch (status) {
		case "completed":
			return "ok";
		case "failed":
			return "err";
		case "cancelled":
			return "warn";
		case "running":
			return "accent";
		default:
			return undefined;
	}
}

const JOB_STATUS_ORDER: Record<string, number> = { running: 0, failed: 1, cancelled: 2, completed: 3 };

function formatJobDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	return `${m}m ${Math.round(s % 60)}s`;
}

function JobRow({ job }: { job: JobSnapshotLike }): ReactNode {
	const tone = jobStatusTone(job.status);
	const label = normalizeWs(job.label) || "(no label)";
	const showId = label !== job.id;
	const rawPreview = job.errorText.trim() || job.resultText.trim();
	const preview = rawPreview ? truncate(normalizeWs(stripTaskResultEnvelope(rawPreview)), 160) : "";
	return (
		<Row k={<Badge tone={tone}>{job.status || "?"}</Badge>}>
			{job.type && <Badge tone={tone}>{job.type}</Badge>}
			{showId && <span className="tv-path"> {job.id}</span>}
			<span> {truncate(label, 80)}</span>
			{job.durationMs > 0 && <span className="tv-faint"> {formatJobDuration(job.durationMs)}</span>}
			{preview && <span className={job.errorText ? "tv-err-text" : "tv-faint"}> — {preview}</span>}
		</Row>
	);
}

function JobSummary({ args }: ToolRenderProps): ReactNode {
	const poll = pollIds(args);
	const cancel = cancelIds(args);
	const items: ReactNode[] = [];
	if (args.list === true) {
		items.push(
			<Badge key="list" tone="accent">
				list
			</Badge>,
		);
	}
	if (cancel.length > 0) {
		items.push(
			<Badge key="cancel" tone="warn">
				{groupLabel("cancel", cancel)}
			</Badge>,
		);
	}
	if (poll.length > 0) {
		items.push(
			<Badge key="poll" tone="accent">
				{groupLabel("poll", poll)}
			</Badge>,
		);
	}
	if (items.length === 0) return <span className="tv-muted">all running jobs</span>;
	return <Badges items={items} />;
}

function JobBody({ args, result }: ToolRenderProps): ReactNode {
	const poll = pollIds(args);
	const cancel = cancelIds(args);
	const details = detailsRecord(result);
	const jobs = jobsOf(details);
	const badOutcomes = cancelOutcomesOf(details).filter(o => o.status !== "cancelled" && o.status !== "");

	let running = 0;
	let completed = 0;
	let failed = 0;
	let cancelledCount = 0;
	for (const job of jobs) {
		if (job.status === "running") running++;
		else if (job.status === "completed") completed++;
		else if (job.status === "failed") failed++;
		else if (job.status === "cancelled") cancelledCount++;
	}

	const sorted = [...jobs].sort((a, b) => {
		const diff = (JOB_STATUS_ORDER[a.status] ?? 4) - (JOB_STATUS_ORDER[b.status] ?? 4);
		return diff !== 0 ? diff : b.durationMs - a.durationMs;
	});

	return (
		<>
			{(args.list === true || poll.length > 0 || cancel.length > 0) && (
				<div className="tv-list">
					{args.list === true && <Row k="list">all jobs</Row>}
					{poll.length > 0 && <Row k="poll">{poll.join(", ")}</Row>}
					{cancel.length > 0 && <Row k="cancel">{cancel.join(", ")}</Row>}
				</div>
			)}
			{jobs.length > 0 && (
				<>
					<Badges
						items={[
							running > 0 && (
								<Badge key="running" tone="accent">
									{running === jobs.length
										? `waiting on ${running}`
										: `waiting on ${running} of ${jobs.length}`}
								</Badge>
							),
							completed > 0 && (
								<Badge key="done" tone="ok">
									{completed} done
								</Badge>
							),
							failed > 0 && (
								<Badge key="failed" tone="err">
									{failed} failed
								</Badge>
							),
							cancelledCount > 0 && (
								<Badge key="cancelled" tone="warn">
									{cancelledCount} cancelled
								</Badge>
							),
						]}
					/>
					<div className="tv-list">
						{sorted.map(job => (
							<JobRow key={job.id} job={job} />
						))}
					</div>
				</>
			)}
			{badOutcomes.length > 0 && (
				<Note tone="warn">{badOutcomes.map(o => `${o.id}: ${o.status.replace(/_/g, " ")}`).join(" · ")}</Note>
			)}
			<ResultText result={result} maxLines={10} title={jobs.length > 0 ? "snapshot" : undefined} />
		</>
	);
}

// ============================================================================
// debug
// ============================================================================

function targetTextOf(args: Record<string, unknown>): string | null {
	return (
		str(args.function) ??
		str(args.name) ??
		str(args.expression) ??
		str(args.command) ??
		str(args.condition) ??
		(typeof args.frame_id === "number" ? `frame ${args.frame_id}` : null) ??
		(typeof args.scope_id === "number" ? `scope ${args.scope_id}` : null) ??
		(typeof args.variable_ref === "number" ? `var ${args.variable_ref}` : null) ??
		(typeof args.pid === "number" ? `pid ${args.pid}` : null) ??
		(typeof args.port === "number" ? `port ${args.port}` : null)
	);
}

const SCALAR_ARGS: ReadonlyArray<readonly [key: string, label: string]> = [
	["adapter", "adapter"],
	["cwd", "cwd"],
	["function", "function"],
	["name", "name"],
	["condition", "condition"],
	["hit_condition", "hit condition"],
	["context", "context"],
	["frame_id", "frame id"],
	["scope_id", "scope id"],
	["variable_ref", "variable ref"],
	["pid", "pid"],
	["host", "host"],
	["port", "port"],
	["levels", "levels"],
	["memory_reference", "memory ref"],
	["instruction_reference", "instruction ref"],
	["instruction_count", "instruction count"],
	["instruction_offset", "instruction offset"],
	["offset", "offset"],
	["count", "count"],
	["data", "data"],
	["data_id", "data id"],
	["access_type", "access"],
	["command", "command"],
	["resolve_symbols", "resolve symbols"],
	["allow_partial", "allow partial"],
	["start_module", "start module"],
	["module_count", "module count"],
	["timeout", "timeout"],
];

interface DebugSnapshot {
	id: string | null;
	adapter: string | null;
	status: string | null;
	program: string | null;
	stopReason: string | null;
	frameName: string | null;
	sourcePath: string | null;
	line: number | null;
	column: number | null;
	exitCode: number | null;
	needsConfigurationDone: boolean;
}

function snapshotOf(result: ToolResultLike | undefined): DebugSnapshot | null {
	const details = detailsRecord(result);
	if (!details || !isRecord(details.snapshot)) return null;
	const s = details.snapshot;
	return {
		id: str(s.id),
		adapter: str(s.adapter),
		status: str(s.status),
		program: str(s.program),
		stopReason: str(s.stopReason),
		frameName: str(s.frameName),
		sourcePath: str(s.sourcePath),
		line: finiteNumber(s.line),
		column: finiteNumber(s.column),
		exitCode: finiteNumber(s.exitCode),
		needsConfigurationDone: s.needsConfigurationDone === true,
	};
}

function DebugSummary(props: ToolRenderProps): ReactNode {
	const { args } = props;
	const program = str(args.program);
	const file = str(args.file);
	const line = finiteNumber(args.line);
	const target = targetTextOf(args);
	const action = str(args.action) ?? str(detailsRecord(props.result)?.action);
	return (
		<>
			<Badge tone="accent">{action ? action.replace(/_/g, " ") : "debug"}</Badge>
			{program !== null ? (
				<PathText path={program} />
			) : file !== null ? (
				<PathText path={file} from={line ?? undefined} />
			) : target !== null ? (
				<span>{truncate(normalizeWs(target), 80)}</span>
			) : null}
		</>
	);
}

function DebugBody(props: ToolRenderProps): ReactNode {
	const { args, result } = props;
	const program = str(args.program);
	const file = str(args.file);
	const line = finiteNumber(args.line);
	const expression = str(args.expression);
	const programArgs = Array.isArray(args.args) ? args.args.filter(a => typeof a === "string") : [];

	const argRows: ReactNode[] = [];
	if (program !== null) {
		argRows.push(
			<Kv key="program" k="program">
				<PathText path={program} />
			</Kv>,
		);
	}
	if (programArgs.length > 0) {
		argRows.push(
			<Kv key="args" k="args">
				{truncate(programArgs.join(" "), 160)}
			</Kv>,
		);
	}
	if (file !== null) {
		argRows.push(
			<Kv key="file" k="file">
				<PathText path={file} from={line ?? undefined} />
			</Kv>,
		);
	} else if (line !== null) {
		argRows.push(
			<Kv key="line" k="line">
				{line}
			</Kv>,
		);
	}
	for (const [key, label] of SCALAR_ARGS) {
		const value = args[key];
		if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
		argRows.push(
			<Kv key={key} k={label}>
				{truncate(display(value), 120)}
			</Kv>,
		);
	}

	let customArgsJson = "";
	if (isRecord(args.arguments)) {
		try {
			customArgsJson = JSON.stringify(args.arguments, null, 2) ?? "";
		} catch {
			customArgsJson = "";
		}
	}

	const snapshot = snapshotOf(result);
	return (
		<>
			{argRows.length > 0 && <KvGrid>{argRows}</KvGrid>}
			{expression !== null && <CodeBlock code={expression} title="expression" maxLines={8} />}
			{customArgsJson && <CodeBlock code={customArgsJson} lang="json" title="arguments" maxLines={10} />}
			{snapshot && (
				<KvGrid>
					{snapshot.id !== null && <Kv k="session">{snapshot.id}</Kv>}
					{snapshot.adapter !== null && <Kv k="adapter">{snapshot.adapter}</Kv>}
					{snapshot.status !== null && (
						<Kv k="status">
							<Badge tone={snapshot.status === "exited" ? "warn" : "ok"}>{snapshot.status}</Badge>
						</Kv>
					)}
					{snapshot.program !== null && (
						<Kv k="program">
							<PathText path={snapshot.program} />
						</Kv>
					)}
					{snapshot.stopReason !== null && <Kv k="stop reason">{snapshot.stopReason}</Kv>}
					{snapshot.frameName !== null && <Kv k="frame">{snapshot.frameName}</Kv>}
					{snapshot.sourcePath !== null && snapshot.line !== null && (
						<Kv k="location">
							<PathText
								path={snapshot.sourcePath}
								sel={snapshot.column !== null ? `${snapshot.line}:${snapshot.column}` : String(snapshot.line)}
							/>
						</Kv>
					)}
					{snapshot.exitCode !== null && <Kv k="exit code">{snapshot.exitCode}</Kv>}
					{snapshot.needsConfigurationDone && (
						<Kv k="configuration">pending configurationDone — set breakpoints, then continue</Kv>
					)}
				</KvGrid>
			)}
			<ResultText result={result} maxLines={10} />
		</>
	);
}

// ============================================================================
// eval
// ============================================================================

interface EvalCell {
	lang: string;
	title: string;
	attrs: string[];
	code: string;
}

const HLJS_LANG: Record<string, string> = {
	py: "python",
	js: "javascript",
	ts: "typescript",
	rb: "ruby",
	jl: "julia",
};

function evalLangAlias(token: string | undefined): string | null {
	const t = (token ?? "").toUpperCase();
	if (t === "PY" || t === "PYTHON" || t === "IPY" || t === "IPYTHON") return "py";
	if (t === "JS" || t === "JAVASCRIPT") return "js";
	if (t === "TS" || t === "TYPESCRIPT") return "ts";
	if (t === "RB" || t === "RUBY") return "rb";
	if (t === "JL" || t === "JULIA") return "jl";
	return null;
}

function tokenizeCellAttrs(input: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	while (i < input.length) {
		while (i < input.length && /\s/.test(input[i])) i++;
		if (i >= input.length) break;
		let tok = "";
		while (i < input.length && !/\s/.test(input[i])) {
			const ch = input[i];
			if (ch === '"' || ch === "'") {
				tok += ch;
				i++;
				while (i < input.length && input[i] !== ch) {
					tok += input[i];
					i++;
				}
				if (i < input.length) {
					tok += input[i];
					i++;
				}
			} else {
				tok += ch;
				i++;
			}
		}
		tokens.push(tok);
	}
	return tokens;
}

function parseEvalCellsCell(text: string): EvalCell[] {
	const CELL = /^\*{2,}\s*Cell\b\s*(.*)$/i;
	const END = /^\*{2,}\s*End\b.*$/i;
	const ATTR = /^([a-zA-Z][\w-]*)(?::(?:"([^"]*)"|'([^']*)'|(.*)))?$/;
	const DUR = /^\d+(?:ms|s|m)?$/;
	const ID_KEYS = ["id", "title", "name", "cell", "file", "label"];
	const T_KEYS = ["t", "timeout", "duration", "time"];
	const RST_KEYS = ["rst", "reset"];
	const lines = text.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const cells: EvalCell[] = [];
	let i = 0;
	while (i < lines.length && lines[i].trim() === "") i++;
	while (i < lines.length) {
		const m = CELL.exec(lines[i]);
		if (!m) {
			i++;
			continue;
		}
		const tokens = tokenizeCellAttrs(m[1] ?? "");
		let lang: string | null = null;
		let title = "";
		const attrs: string[] = [];
		let bareReset = false;
		const titleParts: string[] = [];
		for (const tok of tokens) {
			if (RST_KEYS.includes(tok.toLowerCase())) {
				bareReset = true;
				continue;
			}
			const am = ATTR.exec(tok);
			if (am && tok.includes(":")) {
				const key = am[1].toLowerCase();
				const value = am[2] ?? am[3] ?? am[4] ?? "";
				const lc = evalLangAlias(key);
				if (lc) {
					if (!lang) lang = lc;
					if (!title && value) title = value;
					continue;
				}
				if (ID_KEYS.includes(key)) {
					if (!title) title = value;
					continue;
				}
				if (T_KEYS.includes(key)) {
					attrs.push(`t=${value}`);
					continue;
				}
				if (RST_KEYS.includes(key)) attrs.push("rst");
				continue;
			}
			const lc = evalLangAlias(tok);
			if (lc && !lang) {
				lang = lc;
				continue;
			}
			if (DUR.test(tok)) {
				attrs.push(`t=${tok}`);
				continue;
			}
			titleParts.push(tok);
		}
		if (!title && titleParts.length > 0) title = titleParts.join(" ");
		if (bareReset) attrs.push("rst");
		i++;
		const codeLines: string[] = [];
		while (i < lines.length) {
			if (END.test(lines[i])) {
				i++;
				break;
			}
			if (CELL.test(lines[i])) break;
			codeLines.push(lines[i]);
			i++;
		}
		while (codeLines.length > 0 && codeLines[codeLines.length - 1].trim() === "") codeLines.pop();
		cells.push({ lang: lang ?? "py", title, attrs, code: codeLines.join("\n") });
		while (i < lines.length && lines[i].trim() === "") i++;
	}
	return cells;
}

function parseEvalCellsBegin(text: string): EvalCell[] {
	const BEGIN = /^\*{2,}\s*Begin\b\s*(\S+)?\s*$/i;
	const END = /^\*{2,}\s*End\b.*$/i;
	const TITLE = /^\*{2,}\s*Title\s*:\s*(.+?)\s*$/i;
	const TIMEOUT = /^\*{2,}\s*Timeout\s*:\s*(\S+)\s*$/i;
	const RESET = /^\*{2,}\s*Reset\s*$/i;
	const lines = text.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const cells: EvalCell[] = [];
	let i = 0;
	while (i < lines.length && lines[i].trim() === "") i++;
	while (i < lines.length) {
		const beginMatch = BEGIN.exec(lines[i]);
		if (!beginMatch) {
			i++;
			continue;
		}
		const lang = evalLangAlias(beginMatch[1]) ?? "py";
		i++;
		let title = "";
		const attrs: string[] = [];
		while (i < lines.length) {
			const tm = TITLE.exec(lines[i]);
			if (tm) {
				if (!title) title = tm[1];
				i++;
				continue;
			}
			const to = TIMEOUT.exec(lines[i]);
			if (to) {
				attrs.push(`t=${to[1]}`);
				i++;
				continue;
			}
			if (RESET.test(lines[i])) {
				attrs.push("rst");
				i++;
				continue;
			}
			break;
		}
		const codeLines: string[] = [];
		while (i < lines.length) {
			if (END.test(lines[i])) {
				i++;
				break;
			}
			if (BEGIN.test(lines[i])) break;
			codeLines.push(lines[i]);
			i++;
		}
		while (codeLines.length > 0 && codeLines[codeLines.length - 1].trim() === "") codeLines.pop();
		cells.push({ lang, title, attrs, code: codeLines.join("\n") });
		while (i < lines.length && lines[i].trim() === "") i++;
	}
	return cells;
}

function parseEvalCellsLegacy(input: string): EvalCell[] {
	const HEADER = /^={5,}\s*(.*?)\s*={5,}\s*$/;
	const lines = input.split("\n");
	const cells: EvalCell[] = [];
	let inheritedLang = "py";
	let current: EvalCell | null = null;
	for (const line of lines) {
		const m = HEADER.exec(line);
		if (m) {
			if (current) cells.push(current);
			const info = m[1] ?? "";
			let lang = inheritedLang;
			let title = "";
			const langMatch = info.match(/^(py|js|ts|rb|jl)(?::"([^"]*)")?/);
			if (langMatch) {
				lang = langMatch[1];
				if (langMatch[2]) title = langMatch[2];
			}
			if (!title) {
				const idMatch = info.match(/id:"([^"]*)"/);
				if (idMatch) title = idMatch[1];
			}
			inheritedLang = lang;
			const attrs: string[] = [];
			const tMatch = info.match(/(?:^|\s)t:(\S+)/);
			if (tMatch) attrs.push(`t=${tMatch[1]}`);
			if (/(?:^|\s)rst(?:\s|$)/.test(info)) attrs.push("rst");
			current = { lang, title, attrs, code: "" };
		} else {
			if (!current) current = { lang: inheritedLang, title: "", attrs: [], code: "" };
			current.code += (current.code ? "\n" : "") + line;
		}
	}
	if (current) cells.push(current);
	return cells.map(c => ({ ...c, code: c.code.replace(/\s+$/, "") }));
}

function parseEvalCells(input: string): EvalCell[] {
	if (/^\*{2,}\s*Cell\b/im.test(input)) return parseEvalCellsCell(input);
	if (/^\*{2,}\s*Begin\b/im.test(input)) return parseEvalCellsBegin(input);
	return parseEvalCellsLegacy(input);
}

function cellsFromArgs(args: Record<string, unknown>, name: string): EvalCell[] {
	const raw = args.cells;
	if (Array.isArray(raw)) {
		const out: EvalCell[] = [];
		for (const item of raw) {
			if (!isRecord(item)) continue;
			const attrs: string[] = [];
			const timeout = finiteNumber(item.timeout);
			if (timeout !== null) attrs.push(`t=${timeout}s`);
			if (item.reset === true) attrs.push("rst");
			out.push({
				lang: evalLangAlias(str(item.language) ?? undefined) ?? "py",
				title: str(item.title) ?? "",
				attrs,
				code: str(item.code) ?? "",
			});
		}
		return out;
	}
	const input = str(args.input);
	if (input !== null) return parseEvalCells(input).filter(c => c.code !== "" || c.title !== "");
	const code = str(args.code);
	if (code !== null) {
		const attrs: string[] = [];
		const timeout = finiteNumber(args.timeout);
		if (timeout !== null) attrs.push(`t=${timeout}s`);
		if (args.reset === true) attrs.push("rst");
		const lang = evalLangAlias(str(args.language) ?? undefined) ?? (name === "js" ? "js" : "py");
		return [{ lang, title: str(args.title) ?? "", attrs, code }];
	}
	return [];
}

interface DetailCell {
	index: number;
	title: string;
	code: string;
	lang: string | null;
	output: string;
	status: string;
	durationMs: number | null;
	exitCode: number | null;
}

function detailCellsOf(details: Record<string, unknown> | null): DetailCell[] {
	const raw = details?.cells;
	if (!Array.isArray(raw)) return [];
	const out: DetailCell[] = [];
	for (let i = 0; i < raw.length; i++) {
		const item: unknown = raw[i];
		if (!isRecord(item)) continue;
		const language = str(item.language);
		out.push({
			index: finiteNumber(item.index) ?? i,
			title: str(item.title) ?? "",
			code: str(item.code) ?? "",
			lang: language !== null ? (evalLangAlias(language) ?? "py") : null,
			output: str(item.output) ?? "",
			status: str(item.status) ?? "",
			durationMs: finiteNumber(item.durationMs),
			exitCode: finiteNumber(item.exitCode),
		});
	}
	return out;
}

function renderCells(args: Record<string, unknown>, name: string, detailCells: DetailCell[]): EvalCell[] {
	const cells = cellsFromArgs(args, name);
	if (cells.length > 0) return cells;
	return detailCells.map(c => ({ lang: c.lang ?? "py", title: c.title, attrs: [], code: c.code }));
}

function EvalSummary({ name, args, result }: ToolRenderProps): ReactNode {
	const cells = renderCells(args, name, detailCellsOf(detailsRecord(result)));
	if (cells.length === 0) return <span className="tv-muted">{argsDigest(args)}</span>;
	const first = cells[0];
	const label = first.title || normalizeWs(first.code.split("\n").find(l => l.trim() !== "") ?? "");
	const langs = [...new Set(cells.map(c => c.lang))];
	return (
		<>
			{label && <span>{truncate(label, 72)}</span>}
			<Badges items={[cells.length > 1 ? `${cells.length} cells` : null, ...langs]} />
		</>
	);
}

function EvalBody({ name, args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const detailCells = detailCellsOf(details);
	const cells = renderCells(args, name, detailCells);

	if (cells.length === 0) {
		const badArgs = !Array.isArray(args.cells) && str(args.input) === null && str(args.code) === null;
		return (
			<>
				{badArgs && <InvalidArg what="cells" />}
				<ResultImages result={result} />
				<ResultText result={result} maxLines={12} />
			</>
		);
	}

	const jsonOutputs = Array.isArray(details?.jsonOutputs) ? details.jsonOutputs : [];
	const jsonText = jsonOutputs
		.map(v => {
			try {
				return JSON.stringify(v, null, 2) ?? String(v);
			} catch {
				return String(v);
			}
		})
		.join("\n");
	const notice = str(details?.notice);

	return (
		<>
			<div className="tv-cells">
				{keyed(cells, cell => `${cell.lang}\u001f${cell.code}`).map(({ key, item: cell }, i) => {
					const dc = detailCells.find(c => c.index === i) ?? detailCells[i];
					const titleParts: string[] = [];
					if (cell.title) titleParts.push(cell.title);
					titleParts.push(cell.lang);
					titleParts.push(...cell.attrs);
					if (dc) {
						if (dc.durationMs !== null) {
							const ms = dc.durationMs;
							titleParts.push(ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
						}
						if (dc.status === "error")
							titleParts.push(dc.exitCode !== null ? `error (exit ${dc.exitCode})` : "error");
					}
					return (
						<div className="tv-cell" key={key}>
							<CodeBlock code={cell.code} lang={HLJS_LANG[cell.lang] ?? null} title={titleParts.join(" · ")} />
							{dc && dc.output !== "" && <Output text={dc.output} maxLines={12} error={dc.status === "error"} />}
						</div>
					);
				})}
			</div>
			{jsonText && <Output text={jsonText} lang="json" variant="code" maxLines={12} title="display" />}
			{notice && <Note>{notice}</Note>}
			<ResultImages result={result} />
			{detailCells.length === 0 && <ResultText result={result} maxLines={12} />}
		</>
	);
}

// ============================================================================
// runtime
// ============================================================================

function isRuntimeEval(args: Record<string, unknown>): boolean {
	const op = str(args.op);
	return (
		op === "eval" ||
		op === "exec" ||
		op === "session_start" ||
		op === "session_stop" ||
		typeof args.code === "string" ||
		typeof args.language === "string"
	);
}

function RuntimeSummary(props: ToolRenderProps): ReactNode {
	return isRuntimeEval(props.args) ? <EvalSummary {...props} /> : <LaunchSummary {...props} />;
}

function RuntimeBody(props: ToolRenderProps): ReactNode {
	return isRuntimeEval(props.args) ? <EvalBody {...props} /> : <LaunchBody {...props} />;
}

// ============================================================================
// lsp
// ============================================================================

const DIAG_RE = /^(.*):(\d+):(\d+)\s+\[(\w+)\]\s*(.*)$/;
const LOC_RE = /^(.+):(\d+):(\d+)$/;
const LOCATION_ACTIONS: Record<string, true> = {
	definition: true,
	references: true,
	type_definition: true,
	implementation: true,
};

const MAX_ROWS = 24;

interface DiagRow {
	file: string;
	line: string;
	col: string;
	severity: string;
	message: string;
}

interface LocRow {
	file: string;
	line: string;
	col: string;
}

function parseDiagnostics(text: string): DiagRow[] {
	const rows: DiagRow[] = [];
	for (const raw of text.split("\n")) {
		const m = raw.trim().match(DIAG_RE);
		if (m) rows.push({ file: m[1], line: m[2], col: m[3], severity: m[4].toLowerCase(), message: normalizeWs(m[5]) });
	}
	return rows;
}

function parseLocations(text: string): LocRow[] {
	const rows: LocRow[] = [];
	for (const raw of text.split("\n")) {
		const m = raw.trim().match(LOC_RE);
		if (m) rows.push({ file: m[1], line: m[2], col: m[3] });
	}
	return rows;
}

function severityTone(severity: string): Tone | undefined {
	switch (severity) {
		case "error":
			return "err";
		case "warning":
			return "warn";
		case "info":
			return "accent";
		default:
			return undefined;
	}
}

function ArgKv({ k, raw, val }: { k: string; raw: unknown; val: ReactNode }): ReactNode {
	if (raw === undefined) return null;
	return <Kv k={k}>{val == null || val === false ? <InvalidArg what={k} /> : val}</Kv>;
}

function DiagnosticRows({ text, rows }: { text: string; rows: DiagRow[] }): ReactNode {
	const errMatch = text.match(/(\d+)\s+error\(s\)/);
	const warnMatch = text.match(/(\d+)\s+warning\(s\)/);
	const shown = rows.slice(0, MAX_ROWS);
	return (
		<>
			{(errMatch || warnMatch) && (
				<span className="tv-badges">
					{errMatch && (
						<Badge tone="err">
							{errMatch[1]} error{errMatch[1] === "1" ? "" : "s"}
						</Badge>
					)}
					{warnMatch && (
						<Badge tone="warn">
							{warnMatch[1]} warning{warnMatch[1] === "1" ? "" : "s"}
						</Badge>
					)}
				</span>
			)}
			<div className="tv-list">
				{keyed(shown, d => `${d.file}:${d.line}:${d.col}`).map(({ key, item: d }) => (
					<Row key={key} k={<Badge tone={severityTone(d.severity)}>{d.severity}</Badge>}>
						<PathText path={d.file} sel={`${d.line}:${d.col}`} />
						{d.message && <span className="tv-muted"> {truncate(d.message, 160)}</span>}
					</Row>
				))}
				{rows.length > shown.length && (
					<Row>
						<span className="tv-faint">… {rows.length - shown.length} more</span>
					</Row>
				)}
			</div>
		</>
	);
}

function LocationRows({ text, rows }: { text: string; rows: LocRow[] }): ReactNode {
	const refMatch = text.match(/(\d+)\s+reference\(s\)/);
	const shown = rows.slice(0, MAX_ROWS);
	return (
		<>
			{refMatch && (
				<span className="tv-badges">
					<Badge tone="accent">
						{refMatch[1]} reference{refMatch[1] === "1" ? "" : "s"}
					</Badge>
				</span>
			)}
			<div className="tv-list">
				{keyed(shown, l => `${l.file}:${l.line}:${l.col}`).map(({ key, item: l }) => (
					<Row key={key}>
						<PathText path={l.file} sel={`${l.line}:${l.col}`} />
					</Row>
				))}
				{rows.length > shown.length && (
					<Row>
						<span className="tv-faint">… {rows.length - shown.length} more</span>
					</Row>
				)}
			</div>
		</>
	);
}

function LspSummary({ args }: ToolRenderProps): ReactNode {
	const action = str(args.action);
	const file = str(args.file);
	const line = finiteNumber(args.line);
	const symbol = str(args.symbol);
	const query = str(args.query);
	const newName = str(args.new_name);
	return (
		<>
			<Badge tone="accent">{action ? action.replace(/_/g, " ") : "request"}</Badge>
			{file === "*" && <Badge>workspace</Badge>}
			{file && file !== "*" && <PathText path={file} from={line} />}
			{!file && line != null && <span className="tv-faint">line {line}</span>}
			{symbol && <span className="tv-pattern">{truncate(normalizeWs(symbol), 48)}</span>}
			{query && <span className="tv-muted">{truncate(normalizeWs(query), 48)}</span>}
			{newName && <span className="tv-muted">→ {truncate(normalizeWs(newName), 48)}</span>}
		</>
	);
}

function LspBody({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const file = str(args.file);
	const line = finiteNumber(args.line);
	const symbol = str(args.symbol);
	const query = str(args.query);
	const newName = str(args.new_name);
	const apply = typeof args.apply === "boolean" ? args.apply : null;
	const timeout = finiteNumber(args.timeout);
	const payload = str(args.payload);
	const serverName = details ? str(details.serverName) : null;
	const action = str(args.action) ?? (details ? str(details.action) : null);

	const text = result && !result.isError ? resultTextOf(result) : "";
	const diags = text ? parseDiagnostics(text) : [];
	const locs =
		diags.length === 0 && text && ((action != null && LOCATION_ACTIONS[action]) || /\d+\s+reference\(s\)/.test(text))
			? parseLocations(text)
			: [];

	return (
		<>
			<KvGrid>
				<ArgKv k="action" raw={args.action} val={str(args.action)?.replace(/_/g, " ")} />
				<ArgKv
					k="file"
					raw={args.file}
					val={file === "*" ? <Badge>workspace</Badge> : file && <PathText path={file} from={line} />}
				/>
				{!file && <ArgKv k="line" raw={args.line} val={line} />}
				<ArgKv k="symbol" raw={args.symbol} val={symbol && truncate(normalizeWs(symbol), 120)} />
				<ArgKv k="query" raw={args.query} val={query && truncate(normalizeWs(query), 120)} />
				<ArgKv k="new name" raw={args.new_name} val={newName && truncate(normalizeWs(newName), 120)} />
				<ArgKv k="apply" raw={args.apply} val={apply == null ? null : apply ? "yes" : "no"} />
				<ArgKv k="timeout" raw={args.timeout} val={timeout != null && `${timeout}s`} />
				{args.payload !== undefined && payload == null && (
					<Kv k="payload">
						<InvalidArg what="payload" />
					</Kv>
				)}
				{serverName && <Kv k="server">{serverName}</Kv>}
			</KvGrid>
			{payload && <Output text={payload} lang="json" variant="code" maxLines={8} title="payload" />}
			{diags.length > 0 ? (
				<DiagnosticRows text={text} rows={diags} />
			) : locs.length > 0 ? (
				<LocationRows text={text} rows={locs} />
			) : (
				<ResultText result={result} maxLines={12} />
			)}
		</>
	);
}

// ============================================================================
// browser (alias: puppeteer)
// ============================================================================

interface AppLaunch {
	path: string | null;
	cdpUrl: string | null;
	target: string | null;
}

function appOf(args: Record<string, unknown>): AppLaunch | null {
	const app = args.app;
	if (!isRecord(app)) return null;
	const path = str(app.path);
	const cdpUrl = str(app.cdp_url) ?? str(app.cdpUrl);
	const target = str(app.target);
	if (!path && !cdpUrl && !target) return null;
	return { path, cdpUrl, target };
}

interface BrowserDetails {
	action: string | null;
	name: string | null;
	url: string | null;
	appPath: string | null;
	cdpUrl: string | null;
	target: string | null;
}

function browserDetailsOf(result: ToolResultLike | undefined): BrowserDetails {
	const d = detailsRecord(result);
	return {
		action: d ? str(d.action) : null,
		name: d ? str(d.name) : null,
		url: d ? str(d.url) : null,
		appPath: d ? str(d.appPath) : null,
		cdpUrl: d ? str(d.cdpUrl) : null,
		target: d ? str(d.target) : null,
	};
}

function describeBrowser(app: AppLaunch | null, details: BrowserDetails): string | null {
	const path = details.appPath ?? app?.path;
	if (path) {
		const base = path.split("/").filter(Boolean).pop() ?? path;
		return `app ${base.replace(/\.app$/, "")}`;
	}
	const cdp = details.cdpUrl ?? app?.cdpUrl;
	if (cdp) return `cdp ${cdp}`;
	return null;
}

function browserActionTone(action: string): Tone | undefined {
	switch (action) {
		case "open":
		case "run":
			return "accent";
		case "close":
			return "warn";
		default:
			return undefined;
	}
}

function BrowserSummary({ args, result }: ToolRenderProps): ReactNode {
	const details = browserDetailsOf(result);
	const action = str(args.action) ?? details.action ?? "?";
	const closeAll = action === "close" && (args.all === true || (str(args.name) === null && details.name === null));
	const tab = details.name ?? str(args.name) ?? "main";
	const url = details.url ?? str(args.url);
	return (
		<>
			<Badge tone={browserActionTone(action)}>{action}</Badge>
			<span>{closeAll ? "all tabs" : tab}</span>
			{args.kill === true && <Badge tone="err">kill</Badge>}
			{url && <span className="tv-faint">{truncate(shortenPath(url), 72)}</span>}
		</>
	);
}

function BrowserBody({ args, result }: ToolRenderProps): ReactNode {
	const details = browserDetailsOf(result);
	const action = str(args.action) ?? details.action;
	const app = appOf(args);
	const tab = details.name ?? str(args.name);
	const url = details.url ?? str(args.url);
	const browserDesc = describeBrowser(app, details);
	const viewport = isRecord(args.viewport) ? args.viewport : null;
	const vpWidth = viewport ? finiteNumber(viewport.width) : null;
	const vpHeight = viewport ? finiteNumber(viewport.height) : null;
	const vpScale = viewport ? finiteNumber(viewport.scale) : null;
	const code = str(args.code);
	return (
		<>
			<span className="tv-badges">
				{tab !== null && <Badge>tab {tab}</Badge>}
				{url && <Badge tone="accent">{truncate(shortenPath(url), 120)}</Badge>}
				{browserDesc && <Badge>{browserDesc}</Badge>}
				{app?.target && <Badge>target {app.target}</Badge>}
				{args.all === true && <Badge tone="warn">all</Badge>}
				{args.kill === true && <Badge tone="err">kill</Badge>}
				{vpWidth !== null && vpHeight !== null && (
					<Badge>
						{vpWidth}×{vpHeight}
						{vpScale !== null ? `@${vpScale}x` : ""}
					</Badge>
				)}
			</span>
			{action === "run" && code !== null && <CodeBlock code={code.replace(/\s+$/, "")} lang="javascript" />}
			<ResultImages result={result} />
			<ResultText result={result} maxLines={10} />
		</>
	);
}

// ============================================================================
// fetch
// ============================================================================

interface FetchDetails {
	url: string | null;
	finalUrl: string | null;
	method: string | null;
	contentType: string | null;
	truncated: boolean;
	notes: string[];
}

function fetchDetails(details: Record<string, unknown> | null): FetchDetails | null {
	if (!details) return null;
	const notes: string[] = [];
	if (Array.isArray(details.notes)) {
		for (const n of details.notes) if (typeof n === "string") notes.push(n);
	}
	return {
		url: str(details.url),
		finalUrl: str(details.finalUrl),
		method: str(details.method),
		contentType: str(details.contentType),
		truncated: details.truncated === true,
		notes,
	};
}

function FetchSummary({ args, result }: ToolRenderProps): ReactNode {
	const url = str(args.url) ?? str(args.path);
	const method = (str(args.method) ?? "").toUpperCase();
	const details = fetchDetails(detailsRecord(result));
	return (
		<>
			{url ? <span className="tv-path">{truncate(url, 90)}</span> : <InvalidArg what="url" />}
			{method && method !== "GET" && (
				<>
					{" "}
					<Badge tone="accent">{method}</Badge>
				</>
			)}
			{args.raw === true && (
				<>
					{" "}
					<Badge>raw</Badge>
				</>
			)}
			{details?.truncated && (
				<>
					{" "}
					<Badge tone="warn">truncated</Badge>
				</>
			)}
		</>
	);
}

function FetchBody({ args, result }: ToolRenderProps): ReactNode {
	const url = str(args.url) ?? str(args.path);
	const method = (str(args.method) ?? "").toUpperCase();
	const timeout = finiteNumber(args.timeout);
	const details = fetchDetails(detailsRecord(result));
	const redirected = Boolean(details?.finalUrl && details.url && details.finalUrl !== details.url);
	return (
		<>
			<KvGrid>
				{url && <Kv k="url">{url}</Kv>}
				<Kv k="method">{method && method !== "GET" && <Badge tone="accent">{method}</Badge>}</Kv>
				<Kv k="raw">{args.raw === true && <Badge>raw</Badge>}</Kv>
				<Kv k="timeout">{timeout != null && `${timeout}s`}</Kv>
				<Kv k="final url">{redirected && details?.finalUrl}</Kv>
				<Kv k="content-type">{details?.contentType}</Kv>
				<Kv k="via">{details?.method}</Kv>
				<Kv k="notes">{details && details.notes.length > 0 && details.notes.join("; ")}</Kv>
				<Kv k="truncated">{details?.truncated && <Badge tone="warn">output truncated</Badge>}</Kv>
			</KvGrid>
			<ResultText result={result} maxLines={12} lang="markdown" />
		</>
	);
}

// ============================================================================
// github
// ============================================================================

function shortSha(sha: string): string {
	return sha.slice(0, 7);
}

function Salient({ args }: { args: Record<string, unknown> }): ReactNode {
	const op = str(args.op);
	const repo = str(args.repo);
	const owner = str(args.owner);
	const fullRepo = repo && owner && !repo.includes("/") ? `${owner}/${repo}` : repo;
	const n = finiteNumber(args.pullNumber) ?? finiteNumber(args.issueNumber);
	const title = str(args.title);
	const head = str(args.head);
	const base = str(args.base);
	const branch = str(args.branch);
	const runId = finiteNumber(args.runId);
	const workflow = str(args.workflow);

	const parts: { key: string; node: ReactNode }[] = [];
	if (fullRepo) parts.push({ key: "repo", node: <span className="tv-pattern">{fullRepo}</span> });
	if (n !== null) parts.push({ key: "number", node: <Badge>#{n}</Badge> });
	if (runId !== null) parts.push({ key: "run", node: <Badge>run #{runId}</Badge> });
	if (title) parts.push({ key: "title", node: <span>{truncate(normalizeWs(title), 48)}</span> });
	if (head && base) parts.push({ key: "ref", node: <span className="tv-faint">{`${head} → ${base}`}</span> });
	else if (branch) parts.push({ key: "ref", node: <span className="tv-faint">{branch}</span> });
	if (workflow && op !== "dispatch")
		parts.push({ key: "workflow", node: <span className="tv-faint">{workflow}</span> });
	if (parts.length === 0) return <span className="tv-muted">{argsDigest(args)}</span>;

	return (
		<>
			{parts.map((p, i) => (
				<span key={p.key}>
					{i > 0 && " "}
					{p.node}
				</span>
			))}
		</>
	);
}

function argValue(value: unknown): ReactNode {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) {
		const parts: string[] = [];
		for (const item of value) {
			if (typeof item === "string" || typeof item === "number") parts.push(String(item));
		}
		return parts.join(", ");
	}
	return <InvalidArg />;
}

function ArgsGrid({ args }: { args: Record<string, unknown> }): ReactNode {
	const rows: ReactNode[] = [];
	for (const key in args) {
		if (key === "op" || key === "body") continue;
		const value = args[key];
		if (value === undefined || value === null) continue;
		rows.push(
			<Kv k={key} key={key}>
				{argValue(value)}
			</Kv>,
		);
	}
	return rows.length > 0 ? <KvGrid>{rows}</KvGrid> : null;
}

function jobVisual(job: Record<string, unknown>): { icon: string; cls: string } {
	switch (classifyGithubCheckRun(str(job.status), str(job.conclusion))) {
		case "success":
			return { icon: "✓", cls: "tv-ok-text" };
		case "failure":
			return { icon: "✕", cls: "tv-err-text" };
		case "running":
			return { icon: "●", cls: "tv-warn-text" };
		default:
			return { icon: "○", cls: "tv-faint" };
	}
}

function runTone(status: string | null, conclusion: string | null): "ok" | "err" | "warn" | undefined {
	switch (classifyGithubCheckRun(status, conclusion)) {
		case "success":
			return "ok";
		case "failure":
			return "err";
		case "running":
			return "warn";
		default:
			return undefined;
	}
}

function RunBlock({ run }: { run: Record<string, unknown> }): ReactNode {
	const label = str(run.workflowName) ?? str(run.displayTitle) ?? "GitHub Actions";
	const meta: string[] = [];
	const branch = str(run.branch);
	const sha = str(run.headSha);
	if (branch) meta.push(branch);
	else if (sha) meta.push(shortSha(sha));
	const id = finiteNumber(run.id);
	if (id !== null) meta.push(`#${id}`);
	const conclusion = str(run.conclusion);
	const status = str(run.status);
	const tone = runTone(status, conclusion);
	const jobs = Array.isArray(run.jobs) ? run.jobs : [];
	return (
		<div className="tv-list">
			<Row>
				<span>{label}</span> <span className="tv-muted">{meta.join("  ")}</span>{" "}
				{(conclusion || status) && <Badge tone={tone}>{conclusion ?? status}</Badge>}
			</Row>
			{jobs.length === 0 && (
				<Row>
					<span className="tv-faint">waiting for workflow jobs…</span>
				</Row>
			)}
			{jobs.map((job, index) => {
				if (!isRecord(job)) return null;
				const visual = jobVisual(job);
				const duration = finiteNumber(job.durationSeconds);
				return (
					<Row key={finiteNumber(job.id) ?? index}>
						<span className={visual.cls}>{visual.icon}</span> <span>{str(job.name) ?? "job"}</span>
						{duration !== null && <span className="tv-faint"> {duration}s</span>}
					</Row>
				);
			})}
		</div>
	);
}

function WatchView({ watch }: { watch: Record<string, unknown> }): ReactNode {
	const repo = str(watch.repo) ?? "";
	const watching = str(watch.state) === "watching";
	const run = isRecord(watch.run) ? watch.run : null;
	const runId = run ? finiteNumber(run.id) : null;
	let header: string;
	if (str(watch.mode) === "run" && runId !== null) {
		header = `${watching ? "watching " : ""}run #${runId} on ${repo}`;
	} else {
		const sha = str(watch.headSha);
		const target = sha ? shortSha(sha) : "this commit";
		header = watching ? `watching ${target} on ${repo}` : `workflow runs for ${target} on ${repo}`;
	}
	const note = str(watch.note);
	const runs: Record<string, unknown>[] = [];
	if (run) runs.push(run);
	else if (Array.isArray(watch.runs)) {
		for (const item of watch.runs) {
			if (isRecord(item)) runs.push(item);
		}
	}
	const failedLogs = Array.isArray(watch.failedLogs) ? watch.failedLogs : [];
	return (
		<>
			<div className="tv-muted">{header}</div>
			{note && <div className="tv-faint">{note}</div>}
			{runs.length === 0 && <div className="tv-faint">waiting for workflow runs…</div>}
			{runs.map((item, index) => (
				<RunBlock run={item} key={finiteNumber(item.id) ?? index} />
			))}
			{keyed(
				failedLogs.filter(isRecord),
				entry => `${str(entry.jobName) ?? "job"}\u001f${finiteNumber(entry.runId) ?? ""}`,
			).map(({ key, item: entry }) => {
				const jobName = str(entry.jobName) ?? "job";
				const workflow = str(entry.workflowName);
				const failedRunId = finiteNumber(entry.runId);
				const context = workflow ?? "run";
				const title = `${jobName} — ${context}${failedRunId !== null ? ` #${failedRunId}` : ""}`;
				const tail = str(entry.tail);
				if (!tail || entry.available === false) {
					return (
						<Note tone="warn" key={key}>
							{title}: log tail unavailable
						</Note>
					);
				}
				return <Output text={tail} maxLines={12} error title={title} key={key} />;
			})}
		</>
	);
}

function CheckoutRows({ checkouts }: { checkouts: readonly unknown[] }): ReactNode {
	return (
		<div className="tv-list">
			{checkouts.map((entry, index) => {
				if (!isRecord(entry)) return null;
				const prNumber = finiteNumber(entry.prNumber);
				const worktree = str(entry.worktreePath);
				return (
					<Row k={prNumber !== null ? `#${prNumber}` : "PR"} key={prNumber ?? index}>
						<span>{str(entry.branch) ?? ""}</span>
						{worktree && <span className="tv-muted"> {shortenPath(worktree)}</span>}
						{entry.reused === true && <Badge>reused</Badge>}
					</Row>
				);
			})}
		</div>
	);
}

const DETAIL_KEYS = [
	"repo",
	"branch",
	"worktreePath",
	"remote",
	"remoteBranch",
	"headSha",
	"runId",
	"status",
	"conclusion",
];

function DetailsGrid({ details }: { details: Record<string, unknown> }): ReactNode {
	const rows: ReactNode[] = [];
	for (const key of DETAIL_KEYS) {
		const value = details[key];
		if (typeof value === "number") {
			rows.push(
				<Kv k={key} key={key}>
					{String(value)}
				</Kv>,
			);
		} else if (typeof value === "string" && value) {
			const text = key === "worktreePath" ? shortenPath(value) : key === "headSha" ? shortSha(value) : value;
			rows.push(
				<Kv k={key} key={key}>
					{text}
				</Kv>,
			);
		}
	}
	if (Array.isArray(details.runIds)) {
		const ids: string[] = [];
		for (const id of details.runIds) {
			if (typeof id === "number") ids.push(`#${id}`);
		}
		if (ids.length > 0) {
			rows.push(
				<Kv k="runs" key="runs">
					{ids.join(", ")}
				</Kv>,
			);
		}
	}
	if (Array.isArray(details.failedJobs)) {
		const jobs = strList(details.failedJobs);
		if (jobs.length > 0) {
			rows.push(
				<Kv k="failedJobs" key="failedJobs">
					<span className="tv-err-text">{jobs.join(", ")}</span>
				</Kv>,
			);
		}
	}
	return rows.length > 0 ? <KvGrid>{rows}</KvGrid> : null;
}

function GithubSummary(props: ToolRenderProps): ReactNode {
	const op = str(props.args.op);
	return (
		<>
			{op ? <Badge tone="accent">{op}</Badge> : <Badge tone="warn">no op</Badge>} <Salient args={props.args} />
		</>
	);
}

function GithubBody({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const watch = details && isRecord(details.watch) ? details.watch : null;
	const checkouts = details && Array.isArray(details.checkouts) ? details.checkouts : null;
	const bodyText = str(args.body);
	return (
		<>
			<ArgsGrid args={args} />
			{bodyText && <Output text={bodyText} maxLines={8} title="body" />}
			{watch && <WatchView watch={watch} />}
			{checkouts && checkouts.length > 0 && <CheckoutRows checkouts={checkouts} />}
			{details && !watch && <DetailsGrid details={details} />}
			<ResultText result={result} maxLines={12} lang="markdown" />
		</>
	);
}

// ============================================================================
// Exports
// ============================================================================

export const systemDescriptors: readonly ToolDescriptor[] = [
	{ name: "bash", Summary: BashSummary, Body: BashBody },
	{ name: "ssh", Summary: SshSummary, Body: SshBody },
	{ name: "launch", Summary: LaunchSummary, Body: LaunchBody },
	{ name: "job", aliases: ["await", "poll", "cancel_job"], Summary: JobSummary, Body: JobBody },
	{ name: "debug", Summary: DebugSummary, Body: DebugBody },
	{ name: "eval", aliases: ["js", "python", "notebook"], Summary: EvalSummary, Body: EvalBody },
	{ name: "runtime", Summary: RuntimeSummary, Body: RuntimeBody },
	{ name: "lsp", Summary: LspSummary, Body: LspBody },
	{ name: "browser", aliases: ["puppeteer"], Summary: BrowserSummary, Body: BrowserBody },
	{ name: "fetch", Summary: FetchSummary, Body: FetchBody },
	{ name: "github", Summary: GithubSummary, Body: GithubBody },
];
