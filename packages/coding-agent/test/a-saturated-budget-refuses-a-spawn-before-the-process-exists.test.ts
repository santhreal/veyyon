/**
 * WHY: adopting a child into the session CPU budget after `Bun.spawn` returns
 * cannot un-run it. A saturated session, or one whose budget group could not
 * be created, has to refuse the spawn while the process still does not exist.
 * `cpu-limit.test.ts` proves the limiter refuses; this suite proves the
 * refusal reaches the callers that spawn on the model's behalf, by driving the
 * real extension API and the real Python executor rather than reading their
 * source for the name of a parameter.
 *
 * The class this closes: a spawn path that takes the session gate but never
 * awaits it before creating the process, and a path that resolves the limiter
 * by the wrong key. The eval executors keyed adoption on `options.sessionId`,
 * the namespaced kernel id (`python:<id>`), while the limiter is registered
 * under the tool session id, so the lookup found nothing and the cell ran
 * outside the budget without a word. Both tests here pass a kernel-style
 * `sessionId` that is deliberately not the registered one, so resolving by it
 * again turns them red.
 *
 * The launch tool adds a second half of the same class: a gate applied to
 * every op rather than the ops that create a process. A saturated budget that
 * also refused `stop` and `list` stranded the operator with a runaway daemon
 * and no way to see it or end it, since the one op that frees CPU was the op
 * being refused. The sweep there reads the op union off the tool's own schema,
 * so a new op is red until it is classified as spawning or delivered.
 *
 * What it does not catch: the adopt half of the eval path. `startKernel` only
 * adopts once a kernel is actually starting, which needs a real interpreter,
 * so only the gate half is driven here. `cpu-limit-spawn-sites.test.ts` is
 * what fails when a new file spawns a process and joins neither.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { executePython } from "@veyyon/coding-agent/eval/py/executor";
import { ExtensionRuntime, loadExtensionFromFactory } from "@veyyon/coding-agent/extensibility/extensions/loader";
import type { DaemonBrokerClient } from "@veyyon/coding-agent/launch/client";
import * as launchClient from "@veyyon/coding-agent/launch/client";
import type { DaemonOperation, DaemonRpcResult, DaemonSnapshot } from "@veyyon/coding-agent/launch/protocol";
import type { LaunchParams } from "@veyyon/coding-agent/tools/launch";
import { LaunchTool } from "@veyyon/coding-agent/tools/launch";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { TempDir } from "@veyyon/utils";
import { CpuLimitDeniedError, initSessionCpuLimit, resetSessionCpuLimitsForTests } from "../src/session/cpu-limit";
import { makeCgroupRoot, makeFakeHost, removeCgroupRoots } from "./helpers/fake-cgroup";
import { makeToolSession } from "./helpers/tool-session";

/**
 * The ops that create a process, and the ops that do not. Every op the tool
 * accepts is classified here; `refuses only the ops that create a process`
 * reads the union off the live schema and fails on one that is in neither set,
 * so a new launch op cannot join silently on whichever side happens to compile.
 */
const SPAWNING_OPS = ["start", "restart"] as const;
const DELIVERED_OPS = ["list", "logs", "wait", "send", "stop", "describe"] as const;

const SNAPSHOT: DaemonSnapshot = {
	name: "runaway",
	id: "runaway-1",
	state: "running",
	pid: 9_999,
	createdAt: 0,
	startedAt: 0,
	restartCount: 0,
	outputBytes: 0,
	persist: false,
	detached: false,
};

function paramsForOp(op: LaunchParams["op"]): LaunchParams {
	switch (op) {
		case "start":
			return { op: "start", name: SNAPSHOT.name, application: "echo" };
		case "restart":
			return { op: "restart", name: SNAPSHOT.name };
		case "list":
			return { op: "list" };
		case "send":
			return { op: "send", name: SNAPSHOT.name, text: "hello" };
		default:
			return { op, name: SNAPSHOT.name };
	}
}

/** What the broker would answer. The gate decides whether the op ever gets here. */
function brokerAnswer(operation: DaemonOperation): DaemonRpcResult {
	switch (operation.op) {
		case "list":
			return { op: "list", daemons: [SNAPSHOT], completions: [] };
		case "logs":
			return { op: "logs", name: SNAPSHOT.name, text: "", cursor: 0, timedOut: false, state: SNAPSHOT.state };
		case "wait":
			return { op: "wait", daemon: SNAPSHOT, timedOut: false };
		case "send":
			return { op: "send", daemon: SNAPSHOT };
		case "stop":
			return { op: "stop", daemon: { ...SNAPSHOT, state: "exited" } };
		case "describe":
			return {
				op: "describe",
				daemon: SNAPSHOT,
				spec: {
					name: SNAPSHOT.name,
					application: "echo",
					args: [],
					env: {},
					cwd: process.cwd(),
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			};
		case "start":
			return { op: "start", daemon: SNAPSHOT, readyTimedOut: false };
		case "restart":
			return { op: "restart", daemon: SNAPSHOT };
		case "ping":
			return { op: "ping", projectDir: process.cwd() };
		case "shutdown":
			return { op: "shutdown" };
	}
}

/**
 * Every op the launch tool accepts, read off the schema the tool publishes
 * rather than a list copied into this file. Each narrowing step throws instead
 * of falling back to an empty array, because a sweep that silently enumerates
 * nothing passes while proving nothing.
 */
function opsAcceptedBy(tool: LaunchTool): string[] {
	const schema: unknown = tool.parameters.toJsonSchema();
	if (!schema || typeof schema !== "object" || !("properties" in schema)) {
		throw new Error("launch schema exposes no properties");
	}
	const properties: unknown = schema.properties;
	if (!properties || typeof properties !== "object" || !("op" in properties)) {
		throw new Error("launch schema exposes no op property");
	}
	const op: unknown = properties.op;
	if (!op || typeof op !== "object") throw new Error("launch op has no schema");
	// A described literal union renders as `anyOf` of `const` members; an
	// undescribed one renders as a plain `enum`. Both are read, and anything
	// else throws rather than sweeping an empty set.
	if ("enum" in op && Array.isArray(op.enum)) return op.enum.map(String);
	if ("anyOf" in op && Array.isArray(op.anyOf)) {
		return op.anyOf.map(member => {
			if (!member || typeof member !== "object" || !("const" in member)) {
				throw new Error("launch op union member is not a literal");
			}
			return String(member.const);
		});
	}
	throw new Error("launch op is no longer a literal union");
}

/**
 * A host with no delegated cgroup parent and no systemd: the probe reports
 * unsupported, so a configured budget marks setup failed and every spawn is
 * refused. That is the fail-closed arm the gate exists for.
 */
async function registerUnenforceableBudget(sessionId: string): Promise<void> {
	const root = await makeCgroupRoot();
	await initSessionCpuLimit({
		sessionId,
		cores: 2,
		kill: false,
		onNotice: () => {},
		env: makeFakeHost(root).env,
	});
}

describe("a spawn that cannot join the session budget", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		resetSessionCpuLimitsForTests();
		await removeCgroupRoots();
	});

	it("never starts the process an extension's exec asked for", async () => {
		const dir = TempDir.createSync("@pi-cpu-gate-extension-");
		try {
			const marker = path.join(dir.path(), "the-child-ran");
			// A script file, not an `-e` one-liner: `ExecOptions` carries no env, so a probe that
			// resolves veyyon's directories against the inherited environment could write into the
			// developer's real tree on the day the gate regresses and the child does run. This one
			// touches nothing but the marker inside the temp directory.
			const probe = path.join(dir.path(), "probe.js");
			await fs.writeFile(probe, `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")\n`);
			let execResult: Promise<unknown> | undefined;
			await loadExtensionFromFactory(
				api => {
					execResult = api.exec(process.execPath, [probe]);
				},
				dir.path(),
				new EventBus(),
				new ExtensionRuntime(),
				"<cpu-gate-test>",
				() => {},
				async what => {
					throw new CpuLimitDeniedError(`Refused to start ${what}: saturated`);
				},
			);

			expect(execResult).toBeDefined();
			await expect(execResult).rejects.toThrow(/Refused to start an extension command/);
			expect(await fs.stat(marker).catch(() => null)).toBeNull();
		} finally {
			dir.removeSync();
		}
	});

	it("refuses a Python eval cell by the tool session id, not the kernel id", async () => {
		await registerUnenforceableBudget("sess-eval-gate");

		await expect(
			executePython("1 + 1", {
				// The kernel id is namespaced and is not what the limiter is keyed
				// by. Resolving the gate from this field finds no limiter and the
				// cell runs uncapped.
				sessionId: "python:sess-eval-gate",
				toolSession: makeToolSession({ getSessionId: () => "sess-eval-gate" }),
			}),
		).rejects.toThrow(/Refused to start a Python eval cell/);
	});

	it("refuses only the ops that create a process", async () => {
		await registerUnenforceableBudget("sess-launch-gate");
		const session = makeToolSession({
			getSessionId: () => "sess-launch-gate",
			settings: Settings.isolated({ "session.cpuLimitCores": 2 }),
		});
		const tool = new LaunchTool(session);
		const delivered: string[] = [];
		// The broker is a separate process reached over a socket, so it is the one
		// boundary stubbed here. Everything between the model's arguments and the
		// wire operation is the real tool.
		const client: DaemonBrokerClient = {
			projectDir: session.cwd,
			request: async operation => {
				delivered.push(operation.op);
				return brokerAnswer(operation);
			},
			close: () => {},
		};
		vi.spyOn(launchClient, "daemonClientForProject").mockResolvedValue(client);

		const classified = [...SPAWNING_OPS, ...DELIVERED_OPS];
		expect(opsAcceptedBy(tool).sort()).toEqual([...classified].sort());

		for (const op of SPAWNING_OPS) {
			await expect(tool.execute(`call-${op}`, paramsForOp(op))).rejects.toThrow(
				/Refused to start a background process/,
			);
		}
		expect(delivered).toEqual([]);

		// The ops that report on a runaway daemon or end it must still reach the
		// broker. Refusing `stop` under a saturated budget left the only op that
		// frees CPU unreachable.
		for (const op of DELIVERED_OPS) await tool.execute(`call-${op}`, paramsForOp(op));
		expect(delivered).toEqual([...DELIVERED_OPS]);
	});
});
