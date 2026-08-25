import { describe, expect, it } from "bun:test";
import {
	DAEMON_RESTART_POLICIES,
	DAEMON_SIGNALS,
	DAEMON_STATES,
	DAEMON_TERMINATION_OWNERS,
	type DaemonOperation,
	parseDaemonCompletionRecord,
	parseDaemonRpcResult,
	parseDaemonSnapshot,
	parseDaemonSpec,
	parseDaemonWireRequest,
	parseDaemonWireResponse,
} from "@veyyon/coding-agent/launch/protocol";

/**
 * launch/protocol.ts is the dependency-free wire codec shared by the launch tool, the socket
 * client, and the daemon broker worker. It had ZERO direct test even though every cross-process
 * daemon message flows through it. A decode bug here is a silent protocol break: a mistyped
 * field would either crash the broker or, worse, pass a malformed daemon spec through. These
 * pin the validation contract (which fields are required, which default, which throw) and the
 * two non-obvious behaviors: detached implies persist, and an rpc result is decoded against the
 * PENDING operation's op, not any op field in the payload.
 */

const baseSpec = {
	name: "web",
	application: "node",
	args: ["server.js"],
	env: { PORT: "3000" },
	cwd: "/app",
	pty: false,
	restart: "on-failure",
	persist: false,
};

const baseSnapshot = {
	name: "web",
	id: "abc",
	state: "running",
	createdAt: 1,
	startedAt: 2,
	restartCount: 0,
	outputBytes: 100,
	persist: true,
};

describe("parseDaemonSpec", () => {
	it("decodes a minimal spec, defaulting detached to false", () => {
		expect(parseDaemonSpec(baseSpec)).toEqual({
			name: "web",
			application: "node",
			args: ["server.js"],
			env: { PORT: "3000" },
			cwd: "/app",
			pty: false,
			ready: undefined,
			restart: "on-failure",
			persist: false,
			detached: false,
		});
	});

	it("forces persist true when detached is set, even if persist was false", () => {
		// A detached daemon outlives its launcher, so it must be persistent; the codec enforces
		// this rather than trusting the sender's persist flag.
		const parsed = parseDaemonSpec({ ...baseSpec, persist: false, detached: true });
		expect(parsed.persist).toBe(true);
		expect(parsed.detached).toBe(true);
	});

	it("requires a ready spec to carry at least a log or a port", () => {
		expect(parseDaemonSpec({ ...baseSpec, ready: { port: 8080, timeoutMs: 5000 } }).ready).toEqual({
			log: undefined,
			port: 8080,
			host: undefined,
			timeoutMs: 5000,
		});
		expect(() => parseDaemonSpec({ ...baseSpec, ready: { timeoutMs: 5000 } })).toThrow("ready requires log or port");
	});

	it("rejects an unknown restart policy, an empty name, and a non-string arg", () => {
		expect(() => parseDaemonSpec({ ...baseSpec, restart: "sometimes" })).toThrow("Unknown restart policy: sometimes");
		expect(() => parseDaemonSpec({ ...baseSpec, name: "" })).toThrow("spec.name must be a non-empty string");
		expect(() => parseDaemonSpec({ ...baseSpec, args: [1] })).toThrow("spec.args item must be a string");
	});

	it("parses every restart policy in DAEMON_RESTART_POLICIES and fails on additions", () => {
		for (const policy of DAEMON_RESTART_POLICIES) {
			const parsed = parseDaemonSpec({ ...baseSpec, restart: policy });
			expect(parsed.restart).toBe(policy);
		}
		expect(DAEMON_RESTART_POLICIES).toEqual(["no", "on-failure", "always"]);
	});
});

describe("parseDaemonSnapshot", () => {
	it("decodes a minimal snapshot, defaulting detached to false", () => {
		const parsed = parseDaemonSnapshot(baseSnapshot);
		expect(parsed.name).toBe("web");
		expect(parsed.state).toBe("running");
		expect(parsed.detached).toBe(false);
		expect(parsed.readyPending).toBeUndefined();
	});

	it("keeps a valid readyPending list", () => {
		expect(parseDaemonSnapshot({ ...baseSnapshot, readyPending: ["log", "port"] }).readyPending).toEqual([
			"log",
			"port",
		]);
	});

	it("parses every daemon state in DAEMON_STATES and fails on additions", () => {
		for (const state of DAEMON_STATES) {
			const parsed = parseDaemonSnapshot({ ...baseSnapshot, state });
			expect(parsed.state).toBe(state);
		}
		expect(DAEMON_STATES).toEqual(["starting", "running", "ready", "restarting", "stopping", "exited", "failed"]);
	});

	it("rejects an unknown state, an unknown readiness condition, and a non-finite timestamp", () => {
		expect(() => parseDaemonSnapshot({ ...baseSnapshot, state: "zombie" })).toThrow("Unknown daemon state: zombie");
		expect(() => parseDaemonSnapshot({ ...baseSnapshot, readyPending: ["cpu"] })).toThrow(
			"Unknown readiness condition: cpu",
		);
		expect(() => parseDaemonSnapshot({ ...baseSnapshot, createdAt: Number.NaN })).toThrow(
			"daemon.createdAt must be a finite number",
		);
	});
});

describe("parseDaemonWireRequest", () => {
	it("decodes an authenticated request envelope", () => {
		expect(parseDaemonWireRequest({ id: "1", token: "t", operation: { op: "ping" } })).toEqual({
			id: "1",
			token: "t",
			operation: { op: "ping" },
		});
	});

	it("rejects an empty token", () => {
		expect(() => parseDaemonWireRequest({ id: "1", token: "", operation: { op: "ping" } })).toThrow(
			"request.token must be a non-empty string",
		);
	});

	it("parses every daemon signal in DAEMON_SIGNALS and fails on additions", () => {
		for (const signal of DAEMON_SIGNALS) {
			const parsed = parseDaemonWireRequest({
				id: "1",
				token: "t",
				operation: { op: "send", name: "w", signal },
			});
			expect(parsed.operation.op === "send" && parsed.operation.signal).toBe(signal);
		}
		expect(DAEMON_SIGNALS).toEqual(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGKILL"]);
	});

	it("validates the embedded operation: bad wait target, unknown op, unknown signal", () => {
		expect(() =>
			parseDaemonWireRequest({
				id: "1",
				token: "t",
				operation: { op: "wait", name: "w", for: "done", timeoutMs: 1 },
			}),
		).toThrow("operation.for must be ready or exit");
		expect(() => parseDaemonWireRequest({ id: "1", token: "t", operation: { op: "frobnicate" } })).toThrow(
			"Unknown daemon operation: frobnicate",
		);
		expect(() =>
			parseDaemonWireRequest({ id: "1", token: "t", operation: { op: "send", name: "w", signal: "SIGFOO" } }),
		).toThrow("Unknown daemon signal: SIGFOO");
	});
});

describe("parseDaemonWireResponse", () => {
	it("passes an ok result through untouched and requires a non-empty error on failure", () => {
		expect(parseDaemonWireResponse({ id: "1", ok: true, result: { x: 1 } })).toEqual({
			id: "1",
			ok: true,
			result: { x: 1 },
		});
		expect(parseDaemonWireResponse({ id: "1", ok: false, error: "boom" })).toEqual({
			id: "1",
			ok: false,
			error: "boom",
		});
	});

	it("rejects a non-boolean ok and an empty error string", () => {
		expect(() => parseDaemonWireResponse({ id: "1", ok: "yes" })).toThrow("response.ok must be a boolean");
		expect(() => parseDaemonWireResponse({ id: "1", ok: false, error: "" })).toThrow(
			"response.error must be a non-empty string",
		);
	});
});

describe("parseDaemonRpcResult", () => {
	it("decodes against the pending operation's op, not a field in the payload", () => {
		expect(parseDaemonRpcResult({ op: "ping" }, { projectDir: "/app" })).toEqual({
			op: "ping",
			projectDir: "/app",
		});
	});

	it("defaults a missing logs text to an empty string", () => {
		const op: DaemonOperation = { op: "logs", name: "w", lines: 10, head: false, follow: false, timeoutMs: 1 };
		expect(parseDaemonRpcResult(op, { name: "w", cursor: 5, timedOut: false, state: "ready" })).toEqual({
			op: "logs",
			name: "w",
			text: "",
			terminalText: undefined,
			cursor: 5,
			timedOut: false,
			state: "ready",
		});
	});

	it("decodes a list result by mapping each daemon snapshot", () => {
		const result = parseDaemonRpcResult({ op: "list" }, { daemons: [baseSnapshot] });
		expect(result.op).toBe("list");
		expect(result.op === "list" && result.daemons.length).toBe(1);
		expect(result.op === "list" && result.daemons[0]?.name).toBe("web");
	});
});
describe("parseDaemonCompletionRecord", () => {
	const baseCompletion = {
		name: "job",
		id: "uuid-1",
		terminatedBy: "process-exit",
		createdAt: 100,
		startedAt: 101,
		exitedAt: 200,
		restartCount: 0,
		outputBytes: 42,
		outputTail: "all done",
	};

	it("parses every termination owner in DAEMON_TERMINATION_OWNERS and fails on additions", () => {
		for (const owner of DAEMON_TERMINATION_OWNERS) {
			const record = parseDaemonCompletionRecord({ ...baseCompletion, terminatedBy: owner });
			expect(record.terminatedBy).toBe(owner);
		}
		expect(DAEMON_TERMINATION_OWNERS).toEqual([
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
		]);
	});

	it("decodes optional fields: owner, exitReason, exitCode, signal", () => {
		const record = parseDaemonCompletionRecord({
			...baseCompletion,
			owner: "session-1",
			exitReason: "killed by SIGTERM",
			exitCode: 143,
			signal: "SIGTERM",
		});
		expect(record.owner).toBe("session-1");
		expect(record.exitReason).toBe("killed by SIGTERM");
		expect(record.exitCode).toBe(143);
		expect(record.signal).toBe("SIGTERM");
	});

	it("rejects an unknown termination owner, missing fields, or invalid types", () => {
		expect(() => parseDaemonCompletionRecord({ ...baseCompletion, terminatedBy: "assassin" })).toThrow(
			"Unknown daemon termination owner: assassin",
		);
		expect(() => parseDaemonCompletionRecord({ ...baseCompletion, createdAt: "yesterday" })).toThrow(
			"completion.createdAt must be a finite number",
		);
		expect(() => parseDaemonCompletionRecord({ ...baseCompletion, name: "" })).toThrow(
			"completion.name must be a non-empty string",
		);
		expect(() => parseDaemonCompletionRecord(null)).toThrow("daemon completion must be an object");
	});
});
