/**
 * WHY THIS SUITE EXISTS
 *
 * Every desktop action that reads or writes a setting resolves its store through `actingSettings`,
 * and the order it resolves in decides whether a value reaches what is running. A session on the
 * connection carries its own store, so answering out of the process store would report one value
 * while the session acts on another; with no session, the process store is what the next session
 * joins, so loading a private copy stores a value nothing running honours.
 *
 * THE CLASS THIS CLOSES: an action answering out of a store other than the one the work will run
 * on. All three branches of the resolution are driven here, each discriminated by a value that
 * exists only in the store it is meant to come from, so a reordering, a dropped branch or a stray
 * fresh load returns a value no other branch could have produced.
 *
 * WHAT IT DOES NOT CATCH: which actions call this at all --- the settings-action sweep in
 * `a-setting-written-from-the-window-reaches-what-is-already-running.test.ts` owns that --- and
 * what a loaded store reads off disk, which is the settings loader's own contract.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthStorage } from "@veyyon/ai";
import { Settings } from "../../src/config/settings";
import { actingSettings } from "../../src/gui-host/acting-settings";
import type { ActionContext } from "../../src/gui-host/actions/types";
import { PresentationLedger } from "../../src/gui-host/presentation";
import type { AgentSession } from "../../src/session/agent-session";
import { beginSettingsTest, restoreSettingsTestState } from "../helpers/settings-test-state";

/** A relay nothing dials, one per store, so the answer names the store it came from. */
const SESSION_RELAY = "wss://relay.this-sessions-own.invalid";
const PROCESS_RELAY = "wss://relay.already-running-in-this-process.invalid";

/** An action context carrying only what the resolution reads: a session slot, a cwd and an agent dir. */
function contextFor(dir: string, session: Settings | undefined): ActionContext {
	const socket = new net.Socket();
	socket.destroy();
	return {
		socket,
		clientState: {
			revision: 0,
			presentationLedger: new PresentationLedger(),
			agentSession: session ? ({ settings: session } as unknown as AgentSession) : undefined,
		},
		cwd: dir,
		agentDir: dir,
		authStorage: () => Promise.withResolvers<AuthStorage>().promise,
		requestId: 1,
		actionTag: "LoadSettings",
		reply: { success: () => {}, failure: () => {}, snapshot: () => {} },
	};
}

describe("the settings a window acts on are the ones its session runs on", () => {
	test("answers out of the session's own store while a session is open on the connection", async () => {
		const state = beginSettingsTest();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acting-settings-session-"));
		try {
			await Settings.init({ cwd: dir, agentDir: dir });
			Settings.instance.set("collab.relayUrl", PROCESS_RELAY);
			const session = Settings.isolated({ "collab.relayUrl": SESSION_RELAY });

			const resolved = await actingSettings(contextFor(dir, session));

			expect(resolved).toBe(session);
			expect(resolved.get("collab.relayUrl")).toBe(SESSION_RELAY);
		} finally {
			restoreSettingsTestState(state);
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("answers out of the running process store when no session is open", async () => {
		const state = beginSettingsTest();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acting-settings-process-"));
		try {
			await Settings.init({ cwd: dir, agentDir: dir });
			// Set without a flush: a fresh load cannot see this value, so an
			// answer carrying it can only have come from the running store.
			Settings.instance.set("collab.relayUrl", PROCESS_RELAY);

			const resolved = await actingSettings(contextFor(dir, undefined));

			expect(resolved).toBe(Settings.instance);
			expect(resolved.get("collab.relayUrl")).toBe(PROCESS_RELAY);
		} finally {
			restoreSettingsTestState(state);
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("loads a store for the context's own directories when the process has none", async () => {
		const state = beginSettingsTest();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acting-settings-fresh-"));
		try {
			// `beginSettingsTest` clears the slot, which is the state a window
			// reaches before any session has initialised settings.
			const resolved = await actingSettings(contextFor(dir, undefined));

			expect(resolved).toBeInstanceOf(Settings);
			expect(resolved.getAgentDir()).toBe(dir);
		} finally {
			restoreSettingsTestState(state);
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
