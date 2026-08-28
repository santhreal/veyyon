/**
 * `launch`: start, inspect and stop long-lived background daemons.
 *
 * One tool covering eight operations, and the generic JSON dump made them all
 * look alike. What a reader needs first is the daemon's STATE, because that is
 * the difference between a dev server that came up and one that exited three
 * seconds later, and the exit code and signal are what say which. A `list`
 * answers about several daemons at once and has to stay one scannable block
 * rather than eight nested objects.
 *
 * Everything here reads from `details`, which arrives as plain JSON over the
 * wire and is not trusted: an op may be absent while the call is running, a
 * snapshot may be the wrong shape, and `daemons` may not be an array at all.
 */
import type { ReactNode } from "react";
import { Badge, Badges, Kv, KvGrid, Output, ResultText, Row } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, normalizeWs, num, str, truncate } from "../util";

/** The subset of a `DaemonSnapshot` worth rendering, narrowed from wire JSON. */
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
		pid: num(value.pid),
		exitCode: num(value.exitCode),
		signal: str(value.signal),
		exitReason: str(value.exitReason),
		restartCount: num(value.restartCount),
	};
}

/**
 * A daemon's state is the headline, so its tone carries the same meaning:
 * `ready` and `running` are working, `exited` and `failed` are not, and the
 * transitional states are neither yet.
 */
function stateTone(state: string | null, isError: boolean | undefined): "ok" | "warn" | "err" | undefined {
	if (isError || state === "failed") return "err";
	if (state === "ready" || state === "running") return "ok";
	if (state === "exited") return "warn";
	return undefined;
}

/**
 * Why a daemon is no longer running, in one phrase.
 *
 * A signal and an exit code are different deaths and the numbers alone do not
 * say which: a process killed by SIGKILL and one that chose to exit 137 report
 * the same code through some supervisors, and only the signal field tells them
 * apart.
 */
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

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const op = (details ? str(details.op) : null) ?? str(args.op);
	const daemons = daemonList(details);
	const daemon = firstDaemon(details);
	const name = daemon?.name ?? str(args.name);
	// A `wait` that timed out did NOT observe what it was waiting for, and reading
	// it as a completed wait is the one mistake this summary must not make.
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

/** One row per daemon for `list`, so several stay scannable. */
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

/** `logs` returns virtual terminal rows for display; joined for the block. */
function terminalText(details: Record<string, unknown> | null): string | null {
	if (!details || !Array.isArray(details.terminalRows)) return null;
	const rows = details.terminalRows.filter((row): row is string => typeof row === "string");
	return rows.length > 0 ? rows.join("\n") : null;
}

function Body({ args, result }: ToolRenderProps): ReactNode {
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
					{/* `wait` reports the line that satisfied the pattern. It is the proof
					    the wait succeeded rather than merely stopping. */}
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

/** `spec.args` is wire JSON, so only its string entries are shown. */
function argvText(value: unknown): string {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").join(" ") : "";
}

export const launchRenderer: ToolRenderer = { Summary, Body };
