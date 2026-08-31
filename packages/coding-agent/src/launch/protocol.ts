/**
 * Cross-process daemon broker protocol shared by the tool, client, and broker.
 */
/** Hidden CLI selector used to re-enter the daemon broker worker. */
export const DAEMON_BROKER_WORKER_ARG = "__veyyon_worker_daemon_broker";

/** Fixed dimensions negotiated with every supervised PTY. */
export const DAEMON_PTY_COLUMNS = 120;
export const DAEMON_PTY_ROWS = 40;

// Internal tool→broker-worker handoff keys, set by the launching process and
// deleted by the broker on read (see broker.ts). Not user-configurable, so no
// legacy `OMP_*` alias is kept — the value moves with the veyyon brand.
/** Environment key carrying the broker's canonical project directory. */
export const DAEMON_PROJECT_DIR_ENV = "VEYYON_DAEMON_PROJECT_DIR";

/** Environment key carrying the broker's private runtime directory. */
export const DAEMON_RUNTIME_DIR_ENV = "VEYYON_DAEMON_RUNTIME_DIR";

/** Optional environment key overriding last-client shutdown grace. */
export const DAEMON_IDLE_GRACE_ENV = "VEYYON_DAEMON_IDLE_GRACE_MS";

/** Optional environment key overriding exited daemon cleanup TTL. */
export const DAEMON_CLEANUP_WAIT_ENV = "VEYYON_DAEMON_CLEANUP_WAIT_MS";

/** Default post-exit retention before an exited daemon is purged (15 minutes). */
export const DEFAULT_CLEANUP_WAIT_MS = 15 * 60 * 1000;

/** Stable lifecycle states exposed by the launch tool. */
export const DAEMON_STATES = ["starting", "running", "ready", "restarting", "stopping", "exited", "failed"] as const;
export type DaemonState = (typeof DAEMON_STATES)[number];

/** Restart behavior applied after an unexpected daemon exit. */
export const DAEMON_RESTART_POLICIES = ["no", "on-failure", "always"] as const;
export type DaemonRestartPolicy = (typeof DAEMON_RESTART_POLICIES)[number];
/** Readiness conditions; every configured condition must pass. */
export interface DaemonReadySpec {
	log?: string;
	port?: number;
	host?: string;
	timeoutMs: number;
}

/** Immutable launch specification retained for restart and inspection. */
export interface DaemonSpec {
	name: string;
	application: string;
	args: string[];
	env: Record<string, string>;
	cwd: string;
	pty: boolean;
	ready?: DaemonReadySpec;
	restart: DaemonRestartPolicy;
	persist: boolean;
	detached: boolean;
}

/** Serializable daemon state visible to every client in one project directory. */
export interface DaemonSnapshot {
	name: string;
	id: string;
	state: DaemonState;
	pid?: number;
	createdAt: number;
	startedAt: number;
	readyAt?: number;
	exitedAt?: number;
	exitCode?: number;
	/** Signal name that terminated the process (e.g. "SIGTERM"), when killed by a signal rather than exiting with a code. */
	signal?: string;
	exitReason?: string;
	restartCount: number;
	outputBytes: number;
	owner?: string;
	/** Which component ended the process; set on every terminal transition. */
	terminatedBy?: DaemonTerminationOwner;
	readyMatch?: string;
	/** Readiness conditions still unmet while `state` is `starting`; absent once ready or without a ready spec. */
	readyPending?: ("log" | "port")[];
	persist: boolean;
	detached: boolean;
}

/** Signals accepted by daemon input operations. */
export const DAEMON_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGKILL"] as const;
export type DaemonSignal = (typeof DAEMON_SIGNALS)[number];

/**
 * Every component that can end a supervised process, as a run-time array so a
 * consumer can enumerate the paths instead of restating them.
 *
 * An unexplained death is indistinguishable from a crash, so every terminal
 * transition names one of these owners plus a human reason:
 * - `process-exit`: the process ended on its own (any exit code, or a
 *   broker-side observation error); nothing in veyyon asked it to stop.
 * - `external-signal`: a signal killed the process and NO veyyon component
 *   sent one — the answer to "who SIGTERMed my browser?" being "not us",
 *   which points at an OOM kill or another process.
 * - `operator-stop`: `launch stop`.
 * - `operator-restart`: `launch restart` stopped the previous generation.
 * - `operator-signal`: `launch send signal=...`.
 * - `broker-shutdown`: a client asked the broker to shut down, and it stopped
 *   every non-detached daemon on the way out.
 * - `idle-reaper`: the last veyyon client disconnected, no persistent daemon
 *   or live project presence remained, and the idle grace elapsed — the
 *   default that kills a non-persistent daemon when its last client exits.
 * - `os-signal`: the broker process itself is exiting (OS signal or normal
 *   process exit) and stopped its non-detached daemons first.
 * - `broker-recovery`: a replacement broker found a non-detached daemon its
 *   predecessor left running and terminated it.
 * - `launch-failure`: the broker failed to spawn or attach the process.
 *
 * Adding a member here turns the termination-attribution suite red until the
 * new path is driven and recorded; removing the recording for a member turns
 * it red too.
 */
export const DAEMON_TERMINATION_OWNERS = [
	"process-exit",
	"external-signal",
	"operator-stop",
	"operator-restart",
	"operator-signal",
	"broker-shutdown",
	"idle-reaper",
	"os-signal",
	"broker-recovery",
	"launch-failure",
] as const;

/** The component responsible for a supervised process's termination. */
export type DaemonTerminationOwner = (typeof DAEMON_TERMINATION_OWNERS)[number];

/**
 * The retained record of one completed daemon generation: what it was, how it
 * ended, who ended it, and the tail of its output. Written to the per-project
 * completions store when a daemon reaches a terminal state, so a finished
 * finite job stays queryable after it leaves the active list and across
 * broker restarts.
 */
export interface DaemonCompletionRecord {
	name: string;
	id: string;
	/** The session that started the daemon, when the start named one. */
	owner?: string;
	terminatedBy: DaemonTerminationOwner;
	exitReason?: string;
	exitCode?: number;
	signal?: string;
	createdAt: number;
	startedAt: number;
	exitedAt: number;
	restartCount: number;
	outputBytes: number;
	/** Sanitized tail of the daemon's captured output at termination. */
	outputTail: string;
}

/** Typed broker operation sent over the authenticated socket. */
export type DaemonOperation =
	| { op: "ping" }
	| { op: "start"; spec: DaemonSpec; owner?: string }
	| { op: "list" }
	| {
			op: "logs";
			name: string;
			lines: number;
			head: boolean;
			grep?: string;
			follow: boolean;
			cursor?: number;
			timeoutMs: number;
	  }
	| { op: "wait"; name: string; for: "ready" | "exit"; pattern?: string; timeoutMs: number }
	| { op: "send"; name: string; data?: string; signal?: DaemonSignal }
	| { op: "stop"; name: string; timeoutMs: number }
	| { op: "restart"; name: string }
	| { op: "describe"; name: string }
	| { op: "shutdown" };

/** Typed broker result decoded before it reaches tool code. */
export type DaemonRpcResult =
	| { op: "ping"; projectDir: string }
	| { op: "start"; daemon: DaemonSnapshot; readyTimedOut: boolean }
	| { op: "list"; daemons: DaemonSnapshot[]; completions: DaemonCompletionRecord[] }
	| {
			op: "logs";
			name: string;
			text: string;
			/** Raw PTY byte stream used only to reconstruct the terminal screen. */
			terminalText?: string;
			cursor: number;
			timedOut: boolean;
			state: DaemonState;
	  }
	| { op: "wait"; daemon: DaemonSnapshot; matched?: string; timedOut: boolean }
	| { op: "send"; daemon: DaemonSnapshot }
	| { op: "stop"; daemon: DaemonSnapshot }
	| { op: "restart"; daemon: DaemonSnapshot }
	| { op: "describe"; daemon: DaemonSnapshot; spec: DaemonSpec }
	| { op: "shutdown" };

/** Authenticated request envelope used by socket clients. */
export interface DaemonWireRequest {
	id: string;
	token: string;
	operation: DaemonOperation;
}

/** Response envelope kept raw until matched with its pending operation. */
export type DaemonWireResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };

// launch/protocol.ts is deliberately dependency-free (zero imports) so the
// broker worker can load it in isolation, so this keeps a self-contained copy of
// isRecord rather than importing @veyyon/utils. The type-guards source-lock test
// grandfathers this one file for exactly that reason.
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	return value;
}

function stringValue(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
	return value;
}
function rawString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	return value;
}

function optionalString(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	return stringValue(value, label);
}

function booleanValue(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
	return value;
}

function numberValue(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
	return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
	if (value === undefined) return undefined;
	return numberValue(value, label);
}

function stringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array of strings`);
	const result: string[] = [];
	for (const item of value) result.push(rawString(item, `${label} item`));
	return result;
}

function stringRecord(value: unknown, label: string): Record<string, string> {
	const source = record(value, label);
	const result: Record<string, string> = {};
	for (const key in source) result[key] = rawString(source[key], `${label}.${key}`);
	return result;
}

function daemonState(value: unknown): DaemonState {
	const state = stringValue(value, "daemon state");
	for (const known of DAEMON_STATES) {
		if (known === state) return known;
	}
	throw new Error(`Unknown daemon state: ${state}`);
}

function restartPolicy(value: unknown): DaemonRestartPolicy {
	const policy = stringValue(value, "restart policy");
	for (const known of DAEMON_RESTART_POLICIES) {
		if (known === policy) return known;
	}
	throw new Error(`Unknown restart policy: ${policy}`);
}

function daemonSignal(value: unknown): DaemonSignal {
	const signal = stringValue(value, "signal");
	for (const known of DAEMON_SIGNALS) {
		if (known === signal) return known;
	}
	throw new Error(`Unknown daemon signal: ${signal}`);
}

function terminationOwner(value: unknown): DaemonTerminationOwner {
	const owner = stringValue(value, "terminatedBy");
	for (const known of DAEMON_TERMINATION_OWNERS) {
		if (known === owner) return known;
	}
	throw new Error(`Unknown daemon termination owner: ${owner}`);
}

function readyPendingList(value: unknown): ("log" | "port")[] {
	if (!Array.isArray(value)) throw new Error("daemon.readyPending must be an array");
	const result: ("log" | "port")[] = [];
	for (const item of value) {
		if (item !== "log" && item !== "port") throw new Error(`Unknown readiness condition: ${String(item)}`);
		result.push(item);
	}
	return result;
}

function readySpec(value: unknown): DaemonReadySpec {
	const source = record(value, "ready");
	const log = optionalString(source.log, "ready.log");
	const port = optionalNumber(source.port, "ready.port");
	const host = optionalString(source.host, "ready.host");
	const timeoutMs = numberValue(source.timeoutMs, "ready.timeoutMs");
	if (!log && port === undefined) throw new Error("ready requires log or port");
	return { log, port, host, timeoutMs };
}

/** Decode and validate a daemon launch specification. */
export function parseDaemonSpec(value: unknown): DaemonSpec {
	const source = record(value, "daemon spec");
	const detached = source.detached === undefined ? false : booleanValue(source.detached, "spec.detached");
	return {
		name: stringValue(source.name, "spec.name"),
		application: stringValue(source.application, "spec.application"),
		args: stringArray(source.args, "spec.args"),
		env: stringRecord(source.env, "spec.env"),
		cwd: stringValue(source.cwd, "spec.cwd"),
		pty: booleanValue(source.pty, "spec.pty"),
		ready: source.ready === undefined ? undefined : readySpec(source.ready),
		restart: restartPolicy(source.restart),
		persist: booleanValue(source.persist, "spec.persist") || detached,
		detached,
	};
}

/** Decode and validate one daemon snapshot. */
export function parseDaemonSnapshot(value: unknown): DaemonSnapshot {
	const source = record(value, "daemon snapshot");
	return {
		name: stringValue(source.name, "daemon.name"),
		id: stringValue(source.id, "daemon.id"),
		state: daemonState(source.state),
		pid: optionalNumber(source.pid, "daemon.pid"),
		createdAt: numberValue(source.createdAt, "daemon.createdAt"),
		startedAt: numberValue(source.startedAt, "daemon.startedAt"),
		readyAt: optionalNumber(source.readyAt, "daemon.readyAt"),
		exitedAt: optionalNumber(source.exitedAt, "daemon.exitedAt"),
		exitCode: optionalNumber(source.exitCode, "daemon.exitCode"),
		signal: optionalString(source.signal, "daemon.signal"),
		exitReason: optionalString(source.exitReason, "daemon.exitReason"),
		restartCount: numberValue(source.restartCount, "daemon.restartCount"),
		outputBytes: numberValue(source.outputBytes, "daemon.outputBytes"),
		owner: optionalString(source.owner, "daemon.owner"),
		terminatedBy: source.terminatedBy === undefined ? undefined : terminationOwner(source.terminatedBy),
		readyMatch: optionalString(source.readyMatch, "daemon.readyMatch"),
		readyPending: source.readyPending === undefined ? undefined : readyPendingList(source.readyPending),
		persist: booleanValue(source.persist, "daemon.persist"),
		detached: source.detached === undefined ? false : booleanValue(source.detached, "daemon.detached"),
	};
}

/** Decode and validate one retained completion record. */
export function parseDaemonCompletionRecord(value: unknown): DaemonCompletionRecord {
	const source = record(value, "daemon completion");
	return {
		name: stringValue(source.name, "completion.name"),
		id: stringValue(source.id, "completion.id"),
		owner: optionalString(source.owner, "completion.owner"),
		terminatedBy: terminationOwner(source.terminatedBy),
		exitReason: optionalString(source.exitReason, "completion.exitReason"),
		exitCode: optionalNumber(source.exitCode, "completion.exitCode"),
		signal: optionalString(source.signal, "completion.signal"),
		createdAt: numberValue(source.createdAt, "completion.createdAt"),
		startedAt: numberValue(source.startedAt, "completion.startedAt"),
		exitedAt: numberValue(source.exitedAt, "completion.exitedAt"),
		restartCount: numberValue(source.restartCount, "completion.restartCount"),
		outputBytes: numberValue(source.outputBytes, "completion.outputBytes"),
		outputTail: rawString(source.outputTail, "completion.outputTail"),
	};
}

/** Decode a socket request before the broker acts on it. */
export function parseDaemonWireRequest(value: unknown): DaemonWireRequest {
	const source = record(value, "daemon request");
	return {
		id: stringValue(source.id, "request.id"),
		token: stringValue(source.token, "request.token"),
		operation: parseDaemonOperation(source.operation),
	};
}

/** Decode a socket response envelope before resolving a pending call. */
export function parseDaemonWireResponse(value: unknown): DaemonWireResponse {
	const source = record(value, "daemon response");
	const id = stringValue(source.id, "response.id");
	if (source.ok === true) return { id, ok: true, result: source.result };
	if (source.ok === false) return { id, ok: false, error: stringValue(source.error, "response.error") };
	throw new Error("response.ok must be a boolean");
}

function parseDaemonOperation(value: unknown): DaemonOperation {
	const source = record(value, "daemon operation");
	const op = stringValue(source.op, "operation.op");
	switch (op) {
		case "ping":
		case "list":
		case "shutdown":
			return { op };
		case "start":
			return {
				op,
				spec: parseDaemonSpec(source.spec),
				owner: optionalString(source.owner, "operation.owner"),
			};
		case "logs":
			return {
				op,
				name: stringValue(source.name, "operation.name"),
				lines: numberValue(source.lines, "operation.lines"),
				head: booleanValue(source.head, "operation.head"),
				grep: optionalString(source.grep, "operation.grep"),
				follow: booleanValue(source.follow, "operation.follow"),
				cursor: optionalNumber(source.cursor, "operation.cursor"),
				timeoutMs: numberValue(source.timeoutMs, "operation.timeoutMs"),
			};
		case "wait": {
			const target = stringValue(source.for, "operation.for");
			if (target !== "ready" && target !== "exit") throw new Error("operation.for must be ready or exit");
			return {
				op,
				name: stringValue(source.name, "operation.name"),
				for: target,
				pattern: optionalString(source.pattern, "operation.pattern"),
				timeoutMs: numberValue(source.timeoutMs, "operation.timeoutMs"),
			};
		}
		case "send":
			return {
				op,
				name: stringValue(source.name, "operation.name"),
				data: optionalString(source.data, "operation.data"),
				signal: source.signal === undefined ? undefined : daemonSignal(source.signal),
			};
		case "stop":
			return {
				op,
				name: stringValue(source.name, "operation.name"),
				timeoutMs: numberValue(source.timeoutMs, "operation.timeoutMs"),
			};
		case "restart":
		case "describe":
			return { op, name: stringValue(source.name, "operation.name") };
		default:
			throw new Error(`Unknown daemon operation: ${op}`);
	}
}

/** Decode a broker result using its pending operation as the discriminator. */
export function parseDaemonRpcResult(operation: DaemonOperation, value: unknown): DaemonRpcResult {
	const source = record(value, `${operation.op} result`);
	switch (operation.op) {
		case "ping":
			return { op: "ping", projectDir: stringValue(source.projectDir, "result.projectDir") };
		case "start":
			return {
				op: "start",
				daemon: parseDaemonSnapshot(source.daemon),
				readyTimedOut: booleanValue(source.readyTimedOut, "result.readyTimedOut"),
			};
		case "list": {
			if (!Array.isArray(source.daemons)) throw new Error("result.daemons must be an array");
			if (source.completions !== undefined && !Array.isArray(source.completions)) {
				throw new Error("result.completions must be an array");
			}
			const completions: unknown[] = source.completions === undefined ? [] : source.completions;
			return {
				op: "list",
				daemons: source.daemons.map(parseDaemonSnapshot),
				completions: completions.map(parseDaemonCompletionRecord),
			};
		}
		case "logs":
			return {
				op: "logs",
				name: stringValue(source.name, "result.name"),
				text: typeof source.text === "string" ? source.text : "",
				terminalText:
					source.terminalText === undefined ? undefined : rawString(source.terminalText, "result.terminalText"),
				cursor: numberValue(source.cursor, "result.cursor"),
				timedOut: booleanValue(source.timedOut, "result.timedOut"),
				state: daemonState(source.state),
			};
		case "wait":
			return {
				op: "wait",
				daemon: parseDaemonSnapshot(source.daemon),
				matched: optionalString(source.matched, "result.matched"),
				timedOut: booleanValue(source.timedOut, "result.timedOut"),
			};
		case "send":
			return { op: "send", daemon: parseDaemonSnapshot(source.daemon) };
		case "stop":
			return { op: "stop", daemon: parseDaemonSnapshot(source.daemon) };
		case "restart":
			return { op: "restart", daemon: parseDaemonSnapshot(source.daemon) };
		case "describe":
			return {
				op: "describe",
				daemon: parseDaemonSnapshot(source.daemon),
				spec: parseDaemonSpec(source.spec),
			};
		case "shutdown":
			return { op: "shutdown" };
	}
}
