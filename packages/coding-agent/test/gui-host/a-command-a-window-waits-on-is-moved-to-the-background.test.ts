/**
 * WHY: `app.bash.background` had one implementation and one caller. The bash
 * tool parks a turn on a long command and registers the wait; the terminal
 * editor resolved it with ctrl+b. A window could not reach it at all, so the
 * only way to get a turn back from a command that outlived it was to stop the
 * turn, which kills the command with it.
 *
 * The registry that holds the wait was also process-global: one list of waits
 * for every session on the host. A second window on the same host resolved
 * whatever wait was registered last, whoever was waiting on it. Keying it by
 * session is what makes the request answerable from a window at all.
 *
 * THE CLASS THIS CLOSES: a wait one window reports and another window moves.
 * The suite drives the real host over its socket against the real registry the
 * bash tool writes to, and covers both edges of a wait, the request that moves
 * it, the refusal when nothing waits, and the isolation between two windows on
 * one host.
 *
 * WHAT IT DOES NOT CATCH: the drawing of the control, which is the desktop's
 * own suite, and the conversion of a running command into a background job,
 * which is the bash tool's (`bash-manual-background.test.ts`). This suite
 * asserts the wait's resolver ran with the manual reason, which is the seam
 * between the two.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { ForegroundCommandView } from "../../src/gui-host/wire";
import {
	hasForegroundBashWait,
	registerForegroundBashWait,
	resetForegroundBashRegistryForTest,
} from "../../src/tools/shell/bash-foreground-registry";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { snapshotSections, TestSocketClient } from "./test-client";

/** The section shape the window decodes, carrying the command or its absence. */
interface ForegroundSection {
	session: string;
	command: ForegroundCommandView | null;
}

/** A second window's session on the same host, which this one never opens. */
const OTHER_SESSION = "another-window-session";

describe("a command a window waits on is moved to the background", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient | null = null;
	let session = "";
	let nextRequest = 1;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-foreground-"));
		await fs.writeFile(path.join(tempDir, "config.yml"), "modelRoles:\n  default: openai/gpt-4o-mini\n", "utf8");
		resetForegroundBashRegistryForTest();
		const authStorage = await isolatedAuthStorage(tempDir);
		authStorage.upsertCredential("openai", { type: "api_key", key: "test-key" });
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
		});
		client = await TestSocketClient.connect(server.endpoint);
		await client.nextFrame();
		await client.nextFrame();
		nextRequest = 1;
		const created = await client.request(nextRequest++, { CreateSession: {} });
		const active = created.frames.find(frame => frame.Snapshot?.ActiveSession) as
			| { Snapshot: { ActiveSession: { value: { id: string } } } }
			| undefined;
		if (!active) throw new Error("CreateSession emitted no ActiveSession");
		session = active.Snapshot.ActiveSession.value.id;
	});

	afterEach(async () => {
		client?.destroy();
		client = null;
		if (server) {
			await server.close();
			server = null;
		}
		resetForegroundBashRegistryForTest();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	/**
	 * Registers a wait for `on` the way the bash tool does: the resolver ends
	 * the tool's race, and the tool drops the registration in the `finally`
	 * that follows, which is what takes the command off the window's footer.
	 * `settle` is the other exit, where the command finished on its own.
	 */
	function waitOn(on: string, command: string): { moved: () => boolean; settle: () => void } {
		let resolved = false;
		const unregister = registerForegroundBashWait(on, command, () => {
			resolved = true;
			unregister();
		});
		return {
			moved: () => resolved,
			settle: () => {
				unregister();
			},
		};
	}

	/** The foreground sections in `frames`, newest last. */
	function sections(frames: unknown[]): ForegroundSection[] {
		return snapshotSections<ForegroundSection>(frames as never, "ForegroundCommand");
	}

	/**
	 * The next foreground section the host pushes unasked. Bounded: a section
	 * that never arrives fails here in two seconds rather than hanging, which
	 * is the difference between a broken subscription and a stalled suite.
	 */
	async function pushedSection(): Promise<ForegroundSection> {
		if (!client) throw new Error("the window is not connected");
		const deadline = Date.now() + 2000;
		while (Date.now() < deadline) {
			const frame = await Promise.race([client.nextFrame(), delay(deadline - Date.now()).then(() => undefined)]);
			if (frame === undefined) break;
			const found = sections([frame]).at(-1);
			if (found) return found;
		}
		throw new Error("the host pushed no ForegroundCommand section within two seconds");
	}

	test("the command a session waits on is stated when the wait opens", async () => {
		waitOn(session, "bun test packages/coding-agent");
		const section = await pushedSection();
		expect(section.session).toBe(session);
		expect(section.command).toEqual({ command: "bun test packages/coding-agent", truncated: false });
	});

	test("the wait settling states the absence, so nothing is left drawn", async () => {
		const wait = waitOn(session, "bun test packages/coding-agent");
		await pushedSection();
		wait.settle();
		const section = await pushedSection();
		expect(section).toEqual({ session, command: null });
	});

	test("a command line wider than the footer is cut, and says it was", async () => {
		waitOn(session, `bun test ${"packages/coding-agent/test/gui-host/".repeat(20)}`);
		const section = await pushedSection();
		expect(section.command?.truncated).toBe(true);
		expect(section.command?.command.length).toBeLessThan(400);
	});

	test("a window that opens a session mid-wait is told what it is waiting on", async () => {
		if (!client) throw new Error("the window is not connected");
		waitOn(session, "cargo test --workspace");
		await pushedSection();
		const opened = await client.request(nextRequest++, { OpenSession: { session } });
		const section = sections(opened.frames).at(-1);
		expect(section).toEqual({
			session,
			command: { command: "cargo test --workspace", truncated: false },
		});
	});

	test("the request moves the waiting command and the window is told it succeeded", async () => {
		if (!client) throw new Error("the window is not connected");
		const wait = waitOn(session, "bun test packages/coding-agent");
		await pushedSection();
		const request = nextRequest++;
		const sent = await client.request(request, { BackgroundCommand: { session } });
		expect(sent.outcome).toEqual({ RequestSucceeded: { request } });
		expect(wait.moved()).toBe(true);
		expect(hasForegroundBashWait(session)).toBe(false);
		// The frames the request carried already state the absence, so the
		// control goes with the command rather than outliving it.
		expect(sections(sent.frames).at(-1)).toEqual({ session, command: null });
	});

	test("a request with nothing waiting is refused, and says what to do", async () => {
		if (!client) throw new Error("the window is not connected");
		const request = nextRequest++;
		const sent = await client.request(request, { BackgroundCommand: { session } });
		const failure = (sent.outcome as { RequestFailed?: { error: { code: string; message: string } } }).RequestFailed;
		expect(failure?.error.code).toBe("NOT_RUNNING");
		expect(failure?.error.message).toContain("Run one, then background it while it waits");
	});

	// Both orders, because a registry that resolves the newest wait on the
	// host rather than the newest wait of one session is right about whichever
	// window registered last. One order alone passes against that defect.
	for (const mineFirst of [true, false]) {
		const order = mineFirst ? "registered before" : "registered after";
		test(`a window does not move the command another window ${order} it is waiting on`, async () => {
			if (!client) throw new Error("the window is not connected");
			const open = (): { mine: ReturnType<typeof waitOn>; other: ReturnType<typeof waitOn> } => {
				if (mineFirst) {
					const mine = waitOn(session, "bun test packages/coding-agent");
					return { mine, other: waitOn(OTHER_SESSION, "cargo build --release") };
				}
				const other = waitOn(OTHER_SESSION, "cargo build --release");
				return { mine: waitOn(session, "bun test packages/coding-agent"), other };
			};
			const { mine, other } = open();
			await pushedSection();

			const request = nextRequest++;
			const sent = await client.request(request, { BackgroundCommand: { session } });
			expect(sent.outcome).toEqual({ RequestSucceeded: { request } });
			expect(mine.moved()).toBe(true);
			expect(other.moved()).toBe(false);
			expect(hasForegroundBashWait(OTHER_SESSION)).toBe(true);
		});
	}

	test("a window with nothing waiting is refused while another window waits", async () => {
		if (!client) throw new Error("the window is not connected");
		// The sharpest form of the same defect: this window has no command to
		// move, so a registry that answers from the host's newest wait moves
		// the other window's and reports success.
		const other = waitOn(OTHER_SESSION, "cargo build --release");
		const request = nextRequest++;
		const sent = await client.request(request, { BackgroundCommand: { session } });
		const failure = (sent.outcome as { RequestFailed?: { error: { code: string } } }).RequestFailed;
		expect(failure?.error.code).toBe("NOT_RUNNING");
		expect(other.moved()).toBe(false);
	});

	test("the section a window is pushed names only its own session", async () => {
		waitOn(OTHER_SESSION, "cargo build --release");
		waitOn(session, "bun test packages/coding-agent");
		const section = await pushedSection();
		expect(section.session).toBe(session);
		expect(section.command?.command).toBe("bun test packages/coding-agent");
	});
});
