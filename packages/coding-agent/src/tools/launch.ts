import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@veyyon/agent-core";
import type { ToolExample } from "@veyyon/ai";
import { clampLow, prompt, sanitizeText } from "@veyyon/utils";
import { type } from "arktype";
import { daemonClientForProject } from "../launch/client";
import { DAEMON_COMPLETIONS_LIMIT } from "../launch/completions";
import type {
	DaemonCompletionRecord,
	DaemonOperation,
	DaemonRpcResult,
	DaemonSnapshot,
	DaemonSpec,
	DaemonState,
} from "../launch/protocol";
import { renderTerminalOutput } from "../launch/terminal-output";
import { toolsPrompts } from "../prompts/tools/rows";
import { sessionBudgetLimits, sessionCpuAdoption, sessionCpuLimit } from "../session/cpu-limit";
import type { Theme } from "../theme/theme";
import type { ToolSession } from ".";
import { releaseLaunchExitWatch, watchLaunchedProcessExit } from "./launch-exit-watch";
import { foldToolOutputBookkeeping } from "./output-fold";
import { resolveToCwd } from "./path-utils";
import { formatDuration, previewLine, replaceTabs, shortenPath, TRUNCATE_LENGTHS } from "./render-utils";
import { ToolError } from "./tool-errors";

const launchSchema = type({
	op: type("'start' | 'list' | 'logs' | 'wait' | 'send' | 'stop' | 'restart' | 'describe'").describe(
		"launch operation",
	),
	"name?": type("string <= 48").describe("stable project-scoped launch name"),
	"application?": type("string > 0").describe("start: executable or application path"),
	"args?": type("string[]").describe("start: argv passed directly to the application"),
	"env?": type({ "[string]": "string" }).describe("start: extra environment variables"),
	"cwd?": type("string").describe("start: working directory; defaults to the session directory"),
	"pty?": type("boolean").describe("start: allocate an interactive PTY; default true"),
	"ready?": type({
		"log?": type("string > 0").describe("regex matched against output"),
		"port?": type("number").describe("TCP port that must accept connections"),
		"host?": type("string > 0").describe("TCP readiness host; default 127.0.0.1"),
		"timeout?": type("number > 0").describe("seconds to wait; default 30"),
	}).describe("start: readiness conditions; all supplied conditions must pass"),
	"restart?": type("'no' | 'on-failure' | 'always'").describe("start: restart policy; default no"),
	"persist?": type("boolean").describe("start: survive the last veyyon client exiting; default false"),
	"detached?": type("boolean").describe(
		"start: survive every veyyon and broker exit; implies persist and disables PTY input",
	),
	"lines?": type("number > 0").describe("logs: output lines; default 100, max 1000"),
	"head?": type("boolean").describe("logs: read from the beginning instead of the tail"),
	"grep?": type("string > 0").describe("logs: regex filter"),
	"follow?": type("boolean").describe("logs: wait for output newer than cursor"),
	"cursor?": type("number >= 0").describe("logs: output cursor returned by an earlier call"),
	"for?": type("'ready' | 'exit'").describe("wait: lifecycle condition; default exit"),
	"pattern?": type("string > 0").describe("wait: output regex; takes precedence over for"),
	"text?": type("string > 0").describe("send: stdin text"),
	"enter?": type("boolean").describe("send: append Enter after text; default true"),
	"keys?": type("string[]").describe("send: terminal keys after text"),
	"signal?": type("'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGQUIT' | 'SIGKILL'").describe("send: process-tree signal"),
	"timeout?": type("number > 0").describe("logs/wait/stop: max seconds; default 30 (stop: 5)"),
});

export type LaunchParams = typeof launchSchema.infer;

const KEY_INPUT: Record<string, string> = {
	ENTER: "\r",
	TAB: "\t",
	ESCAPE: "\u001b",
	CTRL_C: "\u0003",
	CTRL_D: "\u0004",
	UP: "\u001b[A",
	DOWN: "\u001b[B",
	RIGHT: "\u001b[C",
	LEFT: "\u001b[D",
};

/** Structured launch state retained for compact TUI rendering. */
export interface LaunchToolDetails {
	op: LaunchParams["op"];
	daemon?: DaemonSnapshot;
	daemons?: DaemonSnapshot[];
	/** list: retained completion records alongside the active daemons. */
	completions?: DaemonCompletionRecord[];
	cursor?: number;
	timedOut?: boolean;
	/** logs: daemon lifecycle state at read time. */
	state?: DaemonState;
	/** logs: virtual terminal rows for display; model-facing content remains sanitized text. */
	terminalRows?: string[];
	/** wait: output line that satisfied the pattern. */
	matched?: string;
	/** describe: immutable launch spec backing the command/cwd detail lines. */
	spec?: DaemonSpec;
}

function requiredName(params: LaunchParams): string {
	if (!params.name) throw new ToolError(`${params.op} requires name`);
	return params.name;
}

function timeoutMs(value: number | undefined, fallbackSeconds: number): number {
	const seconds = clampLow(value ?? fallbackSeconds, 0.05, 3_600);
	return Math.round(seconds * 1_000);
}

function commandSpec(params: LaunchParams, session: ToolSession): DaemonSpec {
	const name = requiredName(params);
	if (!params.application) throw new ToolError("start requires application");
	const ready = params.ready;
	const detached = params.detached ?? false;
	if (ready?.port !== undefined && (!Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65_535)) {
		throw new ToolError("ready.port must be an integer from 1 to 65535");
	}
	if (ready && !ready.log && ready.port === undefined) throw new ToolError("ready requires log or port");
	return {
		name,
		application: params.application,
		args: params.args ?? [],
		env: params.env ?? {},
		cwd: resolveToCwd(params.cwd ?? session.cwd, session.cwd),
		pty: detached ? false : (params.pty ?? true),
		ready: ready
			? {
					log: ready.log,
					port: ready.port,
					host: ready.host,
					timeoutMs: timeoutMs(ready.timeout, 30),
				}
			: undefined,
		restart: params.restart ?? "no",
		persist: (params.persist ?? false) || detached,
		detached,
	};
}

function sendData(params: LaunchParams): string | undefined {
	let data = params.text ?? "";
	if (params.text && (params.enter ?? true)) data += KEY_INPUT.ENTER;
	for (const rawKey of params.keys ?? []) {
		const key = rawKey.trim().toUpperCase();
		const input = KEY_INPUT[key];
		if (input === undefined) throw new ToolError(`Unsupported launch key ${rawKey}`);
		data += input;
	}
	return data || undefined;
}

function operationFor(params: LaunchParams, session: ToolSession): DaemonOperation {
	switch (params.op) {
		case "start":
			return { op: "start", spec: commandSpec(params, session), owner: session.getSessionId?.() ?? undefined };
		case "list":
			return { op: "list" };
		case "logs":
			return {
				op: "logs",
				name: requiredName(params),
				lines: Math.min(1_000, Math.floor(params.lines ?? 100)),
				head: params.head ?? false,
				grep: params.grep,
				follow: params.follow ?? false,
				cursor: params.cursor,
				timeoutMs: timeoutMs(params.timeout, 30),
			};
		case "wait":
			return {
				op: "wait",
				name: requiredName(params),
				for: params.for ?? "exit",
				pattern: params.pattern,
				timeoutMs: timeoutMs(params.timeout, 30),
			};
		case "send":
			return {
				op: "send",
				name: requiredName(params),
				data: sendData(params),
				signal: params.signal,
			};
		case "stop":
			return { op: "stop", name: requiredName(params), timeoutMs: timeoutMs(params.timeout, 5) };
		case "restart":
			return { op: "restart", name: requiredName(params) };
		case "describe":
			return { op: "describe", name: requiredName(params) };
	}
}

export function daemonLabel(daemon: DaemonSnapshot): string {
	const pid = daemon.pid === undefined ? "" : ` pid=${daemon.pid}`;
	// A signal-terminated process reports its signal (e.g. SIGTERM), not a numeric
	// exit code that would mislead (DOG-2).
	const exit = daemon.signal
		? ` signal=${daemon.signal}`
		: daemon.exitCode === undefined
			? ""
			: ` exit=${daemon.exitCode}`;
	// Who ended it and why, so a killed process is never an unexplained death.
	const termination =
		daemon.terminatedBy === undefined
			? ""
			: ` terminated-by=${daemon.terminatedBy}${daemon.exitReason ? ` — ${daemon.exitReason}` : ""}`;
	return `${daemon.name}: ${daemon.state}${pid}${exit} uptime=${formatDuration(
		(daemon.exitedAt ?? Date.now()) - daemon.startedAt,
	)} restarts=${daemon.restartCount} lifetime=${daemonLifetime(daemon)}${termination}`;
}

/**
 * The owning condition that ends a daemon: `last-client-exit` (the default —
 * the broker stops it once the last veyyon in this directory exits),
 * `broker-shutdown` (`persist`: outlives the last client, dies with the
 * broker), or `detached` (survives every veyyon and broker exit).
 */
export function daemonLifetime(daemon: DaemonSnapshot): "detached" | "broker-shutdown" | "last-client-exit" {
	if (daemon.detached) return "detached";
	if (daemon.persist) return "broker-shutdown";
	return "last-client-exit";
}

/** One retained completion record as a list line, with a bounded tail snippet. */
function completionLabel(record: DaemonCompletionRecord): string {
	const outcome = record.signal
		? `signal=${record.signal}`
		: record.exitCode === undefined
			? "ended"
			: `exit=${record.exitCode}`;
	const reason = record.exitReason ? ` — ${record.exitReason}` : "";
	const tailLine = record.outputTail.trimEnd().split("\n").pop()?.trim() ?? "";
	const tail = tailLine ? ` · tail: ${previewLine(tailLine, TRUNCATE_LENGTHS.SHORT)}` : "";
	return `${record.name}: ${outcome} terminated-by=${record.terminatedBy} after ${formatDuration(
		record.exitedAt - record.startedAt,
	)}${reason}${tail}`;
}

/**
 * Human sentences for the readiness conditions still unmet, e.g.
 * `port 5173 on 127.0.0.1 never accepted connections`. `ready` (from the start
 * params) adds the concrete pattern/port; absent it falls back to generic labels.
 */
export function readyPendingSummary(daemon: DaemonSnapshot, ready?: LaunchParams["ready"]): string[] {
	const parts: string[] = [];
	for (const condition of daemon.readyPending ?? []) {
		if (condition === "log") {
			parts.push(ready?.log ? `log pattern /${ready.log}/ never matched` : "the log pattern never matched");
		} else {
			parts.push(
				ready?.port !== undefined
					? `port ${ready.port} on ${ready.host ?? "127.0.0.1"} never accepted connections`
					: "the port never accepted connections",
			);
		}
	}
	return parts;
}

export function toolContent(result: DaemonRpcResult, params: LaunchParams): string {
	switch (result.op) {
		case "ping":
		case "shutdown":
			throw new ToolError(`Internal daemon result ${result.op} is not tool-visible`);
		case "start": {
			const daemon = result.daemon;
			const lines = [`${daemon.state === "failed" ? "Failed to launch" : "Started"} ${daemonLabel(daemon)}`];
			if (daemon.state === "failed" && daemon.exitReason) lines.push(`Reason: ${daemon.exitReason}`);
			if (daemon.readyMatch) lines.push(`Ready log matched: ${daemon.readyMatch}`);
			if (result.readyTimedOut) {
				const pending = readyPendingSummary(daemon, params.ready);
				const cause = pending.length > 0 ? `: ${pending.join("; ")}` : "";
				lines.push(
					`NOT ready — readiness timed out after ${params.ready?.timeout ?? 30}s${cause}. The process is still running (state: ${daemon.state}); follow its logs or stop it.`,
				);
			}
			return lines.join("\n");
		}
		case "list": {
			if (!result.daemons.length && !result.completions.length) return "No daemons.";
			// Show every live daemon, but cap the terminal (exited/failed) tail so
			// the list does not grow unbounded and waste tokens on every call when
			// old jobs pile up (DOG-1). The most recently exited are the useful ones.
			const TERMINAL_SHOWN = 10;
			const isTerminal = (daemon: DaemonSnapshot): boolean => daemon.state === "exited" || daemon.state === "failed";
			const live = result.daemons.filter(daemon => !isTerminal(daemon));
			const exited = result.daemons
				.filter(isTerminal)
				.sort((left, right) => (right.exitedAt ?? 0) - (left.exitedAt ?? 0));
			const shownExited = exited.slice(0, TERMINAL_SHOWN);
			const lines = [...live, ...shownExited].map(daemon => `- ${daemonLabel(daemon)}`);
			const hidden = exited.length - shownExited.length;
			if (hidden > 0) {
				lines.push(
					`… and ${hidden} more exited daemon${hidden === 1 ? "" : "s"} not shown (showing the ${TERMINAL_SHOWN} most recent).`,
				);
			}
			// Retained completion records whose terminal event is NOT already a row
			// above: a daemon replaced by a same-name start, or one a dead broker
			// never settled. Keyed by id+exitedAt so a restarted daemon's earlier
			// generation still shows while its live row does not duplicate.
			const settled = new Set(
				result.daemons
					.filter(daemon => daemon.exitedAt !== undefined)
					.map(daemon => `${daemon.id}${daemon.exitedAt}`),
			);
			const completions = result.completions.filter(record => !settled.has(`${record.id}${record.exitedAt}`));
			if (completions.length > 0) {
				const COMPLETIONS_SHOWN = 10;
				const shown = completions.slice(-COMPLETIONS_SHOWN).reverse();
				lines.push(
					"",
					`Recently completed (records retained: last ${DAEMON_COMPLETIONS_LIMIT} or 24h, across broker restarts):`,
					...shown.map(record => `- ${completionLabel(record)}`),
				);
				if (completions.length > shown.length) {
					lines.push(`… and ${completions.length - shown.length} older retained record(s).`);
				}
			}
			return lines.join("\n");
		}
		case "logs": {
			// Not bounded here. Every tool result except `read` passes the shared spill layer in
			// `output-meta.ts`, which holds the inline window to `tools.artifactSpillThreshold` and
			// keeps the elided bytes recoverable through an `artifact://` id. A second cap here
			// would deliver the same bytes and lose that recovery.
			const text = sanitizeText(result.text);
			return `${text}${text && !text.endsWith("\n") ? "\n" : ""}[${result.name}: ${result.state}; cursor=${result.cursor}${result.timedOut ? "; follow timed out" : ""}]`;
		}
		case "wait": {
			const lines = [daemonLabel(result.daemon)];
			if (result.matched) lines.push(`Matched: ${result.matched}`);
			if (result.timedOut) {
				const pending = readyPendingSummary(result.daemon);
				lines.push(`Wait timed out${pending.length > 0 ? ` (still waiting on: ${pending.join("; ")})` : ""}.`);
			}
			return lines.join("\n");
		}
		case "send":
			return `Sent input to ${daemonLabel(result.daemon)}`;
		case "stop":
			return `Stopped ${daemonLabel(result.daemon)}`;
		case "restart":
			return `Restarted ${daemonLabel(result.daemon)}`;
		case "describe":
			return [
				daemonLabel(result.daemon),
				`Command: ${[result.spec.application, ...result.spec.args].join(" ")}`,
				`Cwd: ${shortenPath(result.spec.cwd)}`,
				`PTY: ${result.spec.pty}; restart=${result.spec.restart}; persist=${result.spec.persist}; detached=${result.spec.detached}`,
			].join("\n");
	}
}

async function toolDetails(result: DaemonRpcResult, params: LaunchParams): Promise<LaunchToolDetails> {
	switch (result.op) {
		case "start":
			return { op: "start", daemon: result.daemon, timedOut: result.readyTimedOut };
		case "list":
			return { op: "list", daemons: result.daemons, completions: result.completions };
		case "logs": {
			const terminalRows =
				result.terminalText === undefined
					? undefined
					: await renderTerminalOutput(result.terminalText, {
							head: params.head ?? false,
							maxRows: Math.min(1_000, Math.floor(params.lines ?? 100)),
						});
			return {
				op: "logs",
				cursor: result.cursor,
				timedOut: result.timedOut,
				state: result.state,
				terminalRows,
			};
		}
		case "wait":
			return { op: "wait", daemon: result.daemon, timedOut: result.timedOut, matched: result.matched };
		case "send":
			return { op: "send", daemon: result.daemon };
		case "stop":
			return { op: "stop", daemon: result.daemon };
		case "restart":
			return { op: "restart", daemon: result.daemon };
		case "describe":
			return { op: "describe", daemon: result.daemon, spec: result.spec };
		case "ping":
		case "shutdown":
			throw new ToolError(`Internal daemon result ${result.op} is not tool-visible`);
	}
}
function approvalFor(params: unknown): ToolApprovalDecision {
	if (typeof params !== "object" || params === null || !("op" in params)) return "exec";
	switch (params.op) {
		case "list":
		case "logs":
		case "wait":
		case "describe":
			return "read";
		default:
			return "exec";
	}
}

/** Project-scoped launch tool for supervising processes in every coding-agent session. */
export class LaunchTool implements AgentTool<typeof launchSchema, LaunchToolDetails, Theme> {
	readonly name = "launch";
	readonly label = "Launch";
	readonly loadMode = "essential";
	readonly summary = "Supervise a shared project process that does not end on its own";
	readonly description = prompt.render(toolsPrompts["tools/launch"].text);
	readonly parameters = launchSchema;
	readonly strict = true;
	readonly examples: readonly ToolExample<LaunchParams>[] = [
		{
			caption: "Start a dev server and wait for its log banner and port",
			call: {
				op: "start",
				name: "web",
				application: "bun",
				args: ["run", "dev"],
				ready: { log: "Local:.*http", port: 5173, timeout: 30 },
			},
		},
		{
			caption: "Follow output after a cursor",
			call: { op: "logs", name: "web", follow: true, cursor: 1842, timeout: 30 },
		},
	];
	readonly approval = approvalFor;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: LaunchParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<LaunchToolDetails, typeof launchSchema>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<LaunchToolDetails>> {
		// Session CPU budget: keep the group in sync on every op, but refuse only
		// the ops that create a process. A saturated budget that also refused
		// `stop` left no way to end the work saturating it. The broker (spawned
		// lazily by the client) joins the group, which covers every daemon it
		// launches by inheritance.
		const getSessionId = () => this.session.getSessionId?.() ?? null;
		const cpuLimit = sessionCpuLimit(getSessionId());
		if (cpuLimit) {
			await cpuLimit.update(
				this.session.settings.get("session.cpuLimitCores"),
				this.session.settings.get("session.cpuLimitKill"),
				sessionBudgetLimits(this.session.settings),
			);
			if (params.op === "start" || params.op === "restart") {
				await cpuLimit.gateSpawn("a background process");
			}
		}
		const client = await daemonClientForProject(this.session.cwd, {
			adoptSpawnedPid: sessionCpuAdoption(getSessionId),
			cleanupWaitMs: this.session.settings.get("launch.cleanupWaitMs"),
		});
		if (params.op === "stop" || params.op === "restart") {
			// The end of a process the caller asked to end is not news. Drop the
			// watch before the request, so the exit it causes reports nothing.
			releaseLaunchExitWatch(this.session, client.projectDir, requiredName(params));
		}
		const result = await client.request(operationFor(params, this.session), signal);
		if (result.op === "start" || result.op === "restart") {
			watchLaunchedProcessExit({ session: this.session, client, daemon: result.daemon });
		}
		return {
			// Folded for the same reason bash and eval are: a test suite streamed
			// through a launched process lands in context identically, and its
			// per-test bookkeeping is re-read on every later turn. A no-op unless
			// the output carries a real run's worth of pass/skip lines.
			content: [{ type: "text", text: replaceTabs(foldToolOutputBookkeeping(toolContent(result, params)).text) }],
			details: await toolDetails(result, params),
		};
	}
}

/** Args shape visible to the renderer, possibly mid-stream (every field optional). */
export type LaunchRenderArgs = Partial<LaunchParams>;

/** Op-specific call context (log filters, wait condition, send payload). */
export function callMeta(args: LaunchRenderArgs): string[] {
	const meta: string[] = [];
	switch (args.op) {
		case "logs":
			if (args.follow) meta.push("follow");
			if (args.grep) meta.push(`grep /${args.grep}/`);
			break;
		case "wait":
			meta.push(args.pattern ? `for /${args.pattern}/` : `for ${args.for ?? "exit"}`);
			break;
		case "send":
			if (args.signal) meta.push(args.signal);
			else if (args.text) meta.push(args.text);
			if (args.keys?.length) meta.push(args.keys.join(" "));
			break;
	}
	return meta.map(entry => previewLine(replaceTabs(entry), TRUNCATE_LENGTHS.SHORT));
}
