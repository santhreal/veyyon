/**
 * The two Live-view actions that are not "hand the main view over": stopping an
 * agent with `x`, and the read-only transcript the card falls back to for the
 * agents it cannot hand over at all.
 *
 * WHY THE FALLBACK EXISTS. Enter normally focuses the agent's live session so
 * you can read it AND reply. Two agents have no such session. An advisor
 * transcript is observability-only, never an addressable peer, so there is
 * nothing on the other end to receive a reply; a collab guest's sessions live on
 * the HOST, so this process has a transcript to read and no session to focus.
 * Both open the read-only viewer instead, which is a narrower surface honestly
 * labelled rather than a focus call that would quietly do nothing.
 *
 * WHY KILL ORDERS ITS STEPS. A running agent is aborted BEFORE it is released:
 * releasing a session mid-turn leaves the provider request in flight with
 * nothing left to receive the response.
 *
 * WHY PARKED AGENTS ARE HERE. The registry only knows agents this PROCESS
 * started. Restart, or come back tomorrow, and every subagent is absent from it
 * while its transcript is still on disk, so the card seeds them from the session
 * tree and shows them as parked instead of pretending the session never had any.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { AgentDashboard } from "@veyyon/coding-agent/modes/components/agent-dashboard";
import type { AgentTranscriptRemote } from "@veyyon/coding-agent/modes/components/agent-transcript-viewer";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { TempDir } from "@veyyon/utils";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

let geometry: StubbedStdoutGeometry;

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	geometry = stubStdoutGeometry({ columns: 120, rows: 40 });
});

afterEach(() => {
	vi.restoreAllMocks();
	AgentRegistry.resetGlobalForTests();
	geometry.restore();
});

function frameOf(dashboard: AgentDashboard): string {
	return dashboard.render(120).join("\n").replace(ANSI_PATTERN, "");
}

/** A never-resolving-nothing session double that records the abort it was asked for. */
function abortableSession(aborts: string[]): AgentSession {
	return {
		subscribe: () => () => {},
		abort: async (options?: { reason?: string }) => {
			aborts.push(options?.reason ?? "");
		},
	} as unknown as AgentSession;
}

/**
 * A lifecycle manager double that records the ids it was asked to release, plus
 * a promise that settles on the first release.
 *
 * The kill runs in a fire-and-forget async block, so the assertion has to wait
 * for the real completion rather than for an arbitrary number of microtasks: a
 * fixed `await Bun.sleep(0)` passes or fails on how many `await`s the
 * implementation happens to contain today.
 */
function recordingLifecycle(released: string[]): {
	lifecycle: () => AgentLifecycleManager;
	firstRelease: Promise<void>;
} {
	const first = Promise.withResolvers<void>();
	const manager = {
		release: async (id: string) => {
			released.push(id);
			first.resolve();
		},
	} as unknown as AgentLifecycleManager;
	return { lifecycle: () => manager, firstRelease: first.promise };
}

describe("Stopping an agent with x", () => {
	/**
	 * Abort first, release second. Reversing the two leaves a provider request in
	 * flight addressed to a session that no longer exists, and the response lands
	 * on nothing.
	 */
	test("aborts a running agent before releasing it", async () => {
		const aborts: string[] = [];
		const released: string[] = [];
		AgentRegistry.global().register({
			id: "Worker",
			displayName: "reviewer",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: abortableSession(aborts),
			sessionFile: null,
			status: "running",
		});
		const { lifecycle, firstRelease } = recordingLifecycle(released);
		const dashboard = new AgentDashboard({ terminalHeight: 40, lifecycle });

		dashboard.handleInput("x");
		await firstRelease;

		expect(aborts).toEqual(["Interrupted by user"]);
		expect(released).toEqual(["Worker"]);
		dashboard.dispose();
	});

	/**
	 * A parked agent has no session to abort, so it is released directly. Calling
	 * `abort` on a null session would throw inside a fire-and-forget handler and
	 * the row would simply never go away, with no error anywhere the operator can
	 * see it.
	 */
	test("releases a parked agent without trying to abort a session it does not have", async () => {
		const released: string[] = [];
		AgentRegistry.global().register({
			id: "Parked",
			displayName: "scout",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: null,
			status: "parked",
		});
		const { lifecycle, firstRelease } = recordingLifecycle(released);
		const dashboard = new AgentDashboard({ terminalHeight: 40, lifecycle });

		dashboard.handleInput("x");
		await firstRelease;

		expect(released).toEqual(["Parked"]);
		dashboard.dispose();
	});

	/**
	 * An advisor transcript is a file, not a run. `x` on it says so rather than
	 * appearing to stop something: a key that silently does nothing teaches the
	 * operator that the key is broken.
	 */
	test("refuses to stop an advisor and states why", () => {
		const released: string[] = [];
		AgentRegistry.global().register({
			id: "Main/advisor",
			displayName: "advisor",
			kind: "advisor",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: "/tmp/does-not-matter.jsonl",
			status: "parked",
		});
		const dashboard = new AgentDashboard({ terminalHeight: 40, lifecycle: recordingLifecycle(released).lifecycle });

		dashboard.handleInput("x");

		expect(frameOf(dashboard)).toContain("read-only advisor transcript");
		expect(released).toEqual([]);
		dashboard.dispose();
	});

	/** `x` on an empty roster is a no-op, not a crash reading `undefined.kind`. */
	test("does nothing when there is no agent under the cursor", () => {
		const released: string[] = [];
		const dashboard = new AgentDashboard({ terminalHeight: 40, lifecycle: recordingLifecycle(released).lifecycle });

		dashboard.handleInput("x");

		expect(released).toEqual([]);
		dashboard.dispose();
	});

	/**
	 * A collab guest cannot stop a session that lives on the host, so the kill is
	 * sent over the wire instead of being run locally against a registry that only
	 * mirrors the host's.
	 */
	test("routes a guest's kill to the host rather than the local lifecycle", () => {
		const released: string[] = [];
		const killed: string[] = [];
		const registry = new AgentRegistry();
		registry.register({
			id: "HostWorker",
			displayName: "reviewer",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: null,
			status: "running",
		});
		const remote: AgentTranscriptRemote = {
			chat: () => {},
			kill: id => killed.push(id),
			revive: () => {},
			readTranscript: async () => null,
		};
		const dashboard = new AgentDashboard({
			terminalHeight: 40,
			registry,
			remote,
			lifecycle: recordingLifecycle(released).lifecycle,
		});

		dashboard.handleInput("x");

		expect(killed).toEqual(["HostWorker"]);
		expect(released).toEqual([]);
		dashboard.dispose();
	});
});

describe("The read-only transcript fallback", () => {
	/**
	 * An advisor is never handed the main view. It is observability-only and not
	 * an addressable peer, so focusing it would put the operator in front of an
	 * editor whose messages have no recipient.
	 */
	test("opens an advisor in the read-only viewer instead of focusing it", () => {
		const focused: string[] = [];
		AgentRegistry.global().register({
			id: "Main/advisor",
			displayName: "advisor",
			kind: "advisor",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: "/tmp/does-not-matter.jsonl",
			status: "parked",
		});
		const dashboard = new AgentDashboard({
			terminalHeight: 40,
			focusAgent: async id => void focused.push(id),
		});

		dashboard.handleInput("\r");

		expect(focused).toEqual([]);
		dashboard.dispose();
	});

	/**
	 * Same for a collab guest, for a different reason: the sessions are on the
	 * host, so there is nothing in this process to focus. The guest reads the
	 * transcript over the wire.
	 */
	test("opens a guest's agent in the read-only viewer, never the local focus path", () => {
		const focused: string[] = [];
		const registry = new AgentRegistry();
		registry.register({
			id: "HostWorker",
			displayName: "reviewer",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: null,
			status: "running",
		});
		const remote: AgentTranscriptRemote = {
			chat: () => {},
			kill: () => {},
			revive: () => {},
			readTranscript: async () => null,
		};
		const dashboard = new AgentDashboard({
			terminalHeight: 40,
			registry,
			remote,
			focusAgent: async id => void focused.push(id),
		});

		dashboard.handleInput("\r");

		expect(focused).toEqual([]);
		dashboard.dispose();
	});

	/** Opening an id that is not registered is refused rather than mounting an empty viewer. */
	test("refuses to open a transcript for an agent that does not exist", () => {
		const dashboard = new AgentDashboard({ terminalHeight: 40 });

		expect(() => dashboard.openTranscript("never-registered")).not.toThrow();
		dashboard.dispose();
	});
});

describe("Agents persisted by earlier runs", () => {
	/**
	 * The restart case. The registry starts empty in a fresh process, so without
	 * this scan the card would report "Nothing running" for a session with a dozen
	 * subagent transcripts sitting next to it on disk.
	 */
	test("registers a previous run's subagents as parked and shows them", async () => {
		using tempDir = TempDir.createSync("@veyyon-dashboard-persisted-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		const workerSessionFile = path.join(tempDir.path(), "main", "Worker.jsonl");
		await Bun.write(sessionFile, "");
		await Bun.write(workerSessionFile, "");
		const registry = new AgentRegistry();
		const dashboard = new AgentDashboard({ terminalHeight: 40, registry, sessionFile });

		await dashboard.persistedSubagentsReady;

		const shown = frameOf(dashboard);
		expect(shown).toContain("Kestrel");
		expect(shown).toContain("parked");
		expect(registry.get("Worker")?.sessionFile).toBe(workerSessionFile);
		expect(registry.get("Worker")?.status).toBe("parked");
		dashboard.dispose();
	});

	/**
	 * `isEmpty` is what the `←←` gesture gates on, and it must not count the
	 * driving session: that one is always registered, so counting it would make
	 * the gesture open an empty card in every session.
	 */
	test("reports an empty roster when only the driving session is registered", () => {
		const registry = new AgentRegistry();
		registry.register({ id: MAIN_AGENT_ID, displayName: "main", kind: "main", session: null, status: "running" });
		const dashboard = new AgentDashboard({ terminalHeight: 40, registry });

		expect(dashboard.isEmpty).toBe(true);
		dashboard.dispose();
	});

	/** And stops reporting empty once a persisted agent lands, which is what un-gates the gesture. */
	test("stops reporting empty once the persisted scan finds a subagent", async () => {
		using tempDir = TempDir.createSync("@veyyon-dashboard-require-content-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		await Bun.write(sessionFile, "");
		await Bun.write(path.join(tempDir.path(), "main", "Worker.jsonl"), "");
		const registry = new AgentRegistry();
		registry.register({ id: MAIN_AGENT_ID, displayName: "main", kind: "main", session: null, status: "running" });
		const dashboard = new AgentDashboard({ terminalHeight: 40, registry, sessionFile });
		expect(dashboard.isEmpty).toBe(true);

		await dashboard.persistedSubagentsReady;

		expect(dashboard.isEmpty).toBe(false);
		dashboard.dispose();
	});

	/**
	 * A collab guest does not scan a local session tree. Its roster is the host's,
	 * mirrored over the wire, and a scan of this machine's sessions would add
	 * agents that have nothing to do with the session being watched.
	 */
	test("skips the local scan entirely for a collab guest", async () => {
		using tempDir = TempDir.createSync("@veyyon-dashboard-guest-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		await Bun.write(sessionFile, "");
		await Bun.write(path.join(tempDir.path(), "main", "Worker.jsonl"), "");
		const registry = new AgentRegistry();
		const remote: AgentTranscriptRemote = {
			chat: () => {},
			kill: () => {},
			revive: () => {},
			readTranscript: async () => null,
		};
		const dashboard = new AgentDashboard({ terminalHeight: 40, registry, remote, sessionFile });

		await dashboard.persistedSubagentsReady;

		expect(registry.get("Worker")).toBeUndefined();
		dashboard.dispose();
	});
});

describe("What a failure says to the operator", () => {
	/**
	 * A failed kill names the agent and the action. It used to print the
	 * exception's own words: stopping an agent whose session could not abort put
	 * "ref.session.abort is not a function. (In 'ref.session.abort({ reason:
	 * USER_INTERRUPT_LABEL })', 'ref.session.abort' is undefined)" on the notice
	 * line, which names no agent, no action, and nothing to do next. The reason is
	 * still there, at the end, as evidence.
	 */
	test("says which agent could not be stopped, and why", async () => {
		AgentRegistry.global().register({
			id: "0-Sub",
			displayName: "scout",
			kind: "sub",
			session: {
				abort: async () => {
					throw new Error("the session is already gone");
				},
			} as unknown as AgentSession,
			status: "running",
		});
		const dashboard = new AgentDashboard({ terminalHeight: 40 });
		dashboard.render(120);

		dashboard.handleInput("x");
		await Bun.sleep(10);

		const shown = dashboard
			.render(120)
			.join("\n")
			.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
		expect(shown).toContain("Could not stop Kestrel");
		expect(shown).toContain("the session is already gone");
		dashboard.dispose();
	});

	/** And the same for a hand-over that the focus controller refuses. */
	test("says which agent could not be opened, and why", async () => {
		AgentRegistry.global().register({
			id: "0-Sub",
			displayName: "scout",
			kind: "sub",
			session: { subscribe: () => () => {} } as unknown as AgentSession,
			status: "running",
		});
		const dashboard = new AgentDashboard({
			terminalHeight: 40,
			focusAgent: async () => {
				throw new Error("collab guests are read-only here");
			},
		});
		dashboard.render(120);

		dashboard.handleInput("\r");
		await Bun.sleep(10);

		const shown = dashboard
			.render(120)
			.join("\n")
			.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
		expect(shown).toContain("Could not open Kestrel");
		expect(shown).toContain("collab guests are read-only here");
		dashboard.dispose();
	});
});
