/**
 * WHY: `/pause` is one switch for the whole host process, not a property of
 * the session a window has open. A host that answered the press without
 * driving `agentPauseGate` would report success to the window that typed it
 * and freeze nothing; one that drove the gate but told only the socket that
 * asked would leave a second window, and a terminal host running in the same
 * process, drawing "running" over agents that are parked, with no control on
 * screen that ends it. A window that attached while the freeze was already in
 * force would be worst off: nothing arrives for it at all, because a
 * transition it missed is never repeated.
 *
 * CLASS CLOSED: host state that belongs to the process reaching only the
 * client that changed it. Three deliveries are asserted for the same
 * production gate: the section on attach, the answer to the press, and the
 * unsolicited broadcast. The broadcast is driven from a transition the host
 * did not receive as an action -- `agentPauseGate.pause()` called directly, as
 * a terminal's `/pause` in this process does -- so a host that only echoed its
 * own handler fails here. Both refusals are asserted by code, because a
 * second press that reported success would teach the operator a second release
 * is owed.
 *
 * The freeze is proven against the gate the agent loop polls
 * (`agentPauseGate.waitUntilResumed`), with a bound on both sides: a waiter is
 * asserted not to settle while the freeze holds, and asserted to settle after
 * the release rather than merely to have been asked to. A test that only read
 * `gate.paused` back could not tell a gate that parks from a boolean nobody
 * waits on.
 *
 * NOT CAUGHT: that `agentLoop` polls the gate at its action boundaries, which
 * `packages/agent/test` owns against the loop itself; and the strip the window
 * draws from the section, which
 * `crates/veyyon-desktop/tests/a-freeze-the-host-engaged-reaches-every-window.rs`
 * owns.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { agentPauseGate } from "@veyyon/agent-core";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";
import { type RequestFrame, snapshotSections, TestSocketClient } from "./test-client";

const makeTempDir = useTrackedTempDirs("gui-host-pause-test-");

/** What the host states about the freeze. */
interface AgentPauseSection {
	paused: boolean;
	since_ms: number | null;
}

/** How long a waiter is watched before it counts as parked. */
const PARK_OBSERVATION_MS = 50;
/** How long a release is given to wake a parked waiter before it counts as hung. */
const WAKE_DEADLINE_MS = 1_000;

/** A promise that settles to `marker` if `inner` has not settled by the deadline. */
async function settledWithin<T>(inner: Promise<T>, ms: number, marker: T): Promise<T> {
	return await Promise.race([inner, sleep(ms, marker)]);
}

describe("a freeze holds every agent until one window releases it", () => {
	let tempDir: string;
	let agentDir: string;
	let server: GuiHostServer | null = null;

	beforeEach(async () => {
		tempDir = makeTempDir();
		agentDir = path.join(tempDir, "agent");
		await fs.mkdir(agentDir, { recursive: true });
	});

	afterEach(async () => {
		if (server) {
			await server.close();
			server = null;
		}
		// The gate outlives this file, so a freeze left engaged would park every
		// agent loop in every suite that runs after it.
		agentPauseGate.resume();
		vi.restoreAllMocks();
	});

	/** A started host and one attached client. */
	async function attach(): Promise<{ host: GuiHostServer; client: TestSocketClient }> {
		const host = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir, agentDir });
		server = host;
		return { host, client: await TestSocketClient.connect(host.endpoint) };
	}

	/** The next `AgentPause` section the client is sent, within the wake deadline. */
	async function nextPauseSection(client: TestSocketClient): Promise<AgentPauseSection> {
		for (;;) {
			const frame = (await settledWithin(client.nextFrame() as Promise<RequestFrame>, WAKE_DEADLINE_MS, {
				timedOut: true,
			} as RequestFrame)) as RequestFrame & { timedOut?: boolean };
			if (frame.timedOut) throw new Error("no AgentPause frame arrived before the deadline");
			const [section] = snapshotSections<AgentPauseSection>([frame], "AgentPause");
			if (section) return section;
		}
	}

	test("the press freezes the gate every agent loop parks on, and the release wakes it", async () => {
		const { client } = await attach();

		const engaged = await client.request(1, "PauseAgents");
		expect(engaged.outcome).toEqual({ RequestSucceeded: { request: 1 } });
		expect(agentPauseGate.paused).toBe(true);

		// The park is the product behaviour: a loop that reached its next action
		// boundary waits here rather than calling the model.
		let woke = false;
		const parked = agentPauseGate.waitUntilResumed().then(() => {
			woke = true;
		});
		await settledWithin(parked, PARK_OBSERVATION_MS, undefined);
		expect(woke).toBe(false);

		const released = await client.request(2, "ResumeAgents");
		expect(released.outcome).toEqual({ RequestSucceeded: { request: 2 } });
		expect(agentPauseGate.paused).toBe(false);

		await settledWithin(parked, WAKE_DEADLINE_MS, undefined);
		expect(woke).toBe(true);

		client.destroy();
	});

	test("a second press is refused rather than stacking a freeze the operator must release twice", async () => {
		const { client } = await attach();
		await client.request(1, "PauseAgents");

		const second = await client.request(2, "PauseAgents");

		expect(second.outcome.RequestFailed?.error).toMatchObject({
			scope: "Connection",
			code: "ALREADY_PAUSED",
			retryable: false,
		});
		expect(agentPauseGate.paused).toBe(true);

		// One release ends the one freeze, which is what the refusal promised.
		const released = await client.request(3, "ResumeAgents");
		expect(released.outcome).toEqual({ RequestSucceeded: { request: 3 } });
		expect(agentPauseGate.paused).toBe(false);

		client.destroy();
	});

	test("a release with nothing frozen is refused rather than reported as one", async () => {
		const { client } = await attach();

		const outcome = (await client.request(1, "ResumeAgents")).outcome;

		expect(outcome.RequestFailed?.error).toMatchObject({
			scope: "Connection",
			code: "NOTHING_PAUSED",
			retryable: false,
		});
		expect(agentPauseGate.paused).toBe(false);

		client.destroy();
	});

	test("a freeze released in the millisecond it began is a release, not a refusal", async () => {
		const { client } = await attach();
		// The gate answers a release with the duration it held, which is 0 for a
		// freeze pressed and released inside one millisecond. A handler reading
		// that as falsy rather than as `undefined` would refuse a release it had
		// already performed, leaving the window drawing a strip over a host that
		// is running. The clock is pinned so the duration is 0 by construction.
		const frozenClock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

		await client.request(1, "PauseAgents");
		const released = await client.request(2, "ResumeAgents");
		frozenClock.mockRestore();

		expect(released.outcome).toEqual({ RequestSucceeded: { request: 2 } });
		expect(agentPauseGate.paused).toBe(false);

		client.destroy();
	});

	test("a window that attaches mid-freeze is told when the freeze began", async () => {
		const { host } = await attach();
		agentPauseGate.pause();
		const since = agentPauseGate.pausedAt;

		const late = await TestSocketClient.connect(host.endpoint);
		const attached = await late.request(1, "Attach");

		const [section] = snapshotSections<AgentPauseSection>(attached.frames, "AgentPause");
		expect(section).toEqual({ paused: true, since_ms: since ?? null });

		late.destroy();
	});

	test("a window that attaches to a running host is told the host is running", async () => {
		const { client } = await attach();

		const attached = await client.request(1, "Attach");

		const [section] = snapshotSections<AgentPauseSection>(attached.frames, "AgentPause");
		expect(section).toEqual({ paused: false, since_ms: null });

		client.destroy();
	});

	test("a freeze no window engaged reaches every window", async () => {
		const { host, client } = await attach();
		const second = await TestSocketClient.connect(host.endpoint);
		await client.request(1, "Attach");
		await second.request(1, "Attach");

		// A terminal host sharing this process engages the gate directly, which
		// is the transition no client sent as an action.
		agentPauseGate.pause();

		expect(await nextPauseSection(client)).toEqual({
			paused: true,
			since_ms: agentPauseGate.pausedAt ?? null,
		});
		expect(await nextPauseSection(second)).toEqual({
			paused: true,
			since_ms: agentPauseGate.pausedAt ?? null,
		});

		agentPauseGate.resume();

		expect(await nextPauseSection(client)).toEqual({ paused: false, since_ms: null });
		expect(await nextPauseSection(second)).toEqual({ paused: false, since_ms: null });

		client.destroy();
		second.destroy();
	});

	test("a release one window pressed reaches the window that did not press it", async () => {
		const { host, client } = await attach();
		const second = await TestSocketClient.connect(host.endpoint);
		await client.request(1, "Attach");
		await second.request(1, "Attach");

		await client.request(2, "PauseAgents");
		expect(await nextPauseSection(second)).toMatchObject({ paused: true });

		await second.request(2, "ResumeAgents");

		expect(await nextPauseSection(client)).toEqual({ paused: false, since_ms: null });

		client.destroy();
		second.destroy();
	});

	test("a closed host leaves no listener writing into the sockets it destroyed", async () => {
		const { client } = await attach();
		await client.request(1, "Attach");
		await server?.close();
		server = null;

		// A subscription left on the process-global gate would fire here, which
		// is the transition that used to write frames into destroyed sockets.
		agentPauseGate.pause();
		agentPauseGate.resume();

		await sleep(PARK_OBSERVATION_MS);
		expect(agentPauseGate.paused).toBe(false);

		client.destroy();
	});
});
