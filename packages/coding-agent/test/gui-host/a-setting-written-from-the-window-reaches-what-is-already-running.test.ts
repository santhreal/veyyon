/**
 * WHY THIS SUITE EXISTS
 *
 * A settings action taken on a window with no session open acted on a settings
 * store loaded for that one action. The write reached disk, so a reopened
 * window showed the new value and the change looked applied; every session
 * already running in the process kept the values it had loaded at startup and
 * went on acting on them. A relay URL set and then shared with was the shape it
 * was found in: the share was started against the old value, and the setting
 * was stored and ignored until a restart. The read has the mirror fault ---
 * reporting a value off disk that nothing in the process is acting on --- so a
 * window could be shown a setting no running turn would honour.
 *
 * THE CLASS THIS CLOSES. Every settings action that reads or writes the store
 * is driven here against a process that has already initialised it, with no
 * session on the connection, which is the state the defect needed. Each case
 * discriminates the running store from the file: the value is put on the
 * running store WITHOUT a flush, so an action that loads its own copy cannot
 * see it, and an action that writes is read back off the running store rather
 * than off disk. The action list is swept from the handler map at run time and
 * pinned by exact equality, so a settings action added later fails this suite
 * until it is given a case or recorded as acting on something other than the
 * store.
 *
 * WHAT IT DOES NOT CATCH. That the value persists across a restart, which
 * `settings-themes-and-keybindings-are-configured-and-persisted.test.ts` owns
 * and which passed throughout the defect. Nor which store a session that IS
 * open acts on: that is a session's own, and is the first branch of the
 * resolution rather than the one that was wrong. The sweep reads
 * `settingsActionHandlers`, so an action that reads settings from some other
 * handler map is outside it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { SETTINGS_SCHEMA } from "../../src/config/settings-schema";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import { settingsActionHandlers } from "../../src/gui-host/actions/settings";
import type { SettingEntryView, ThemesView } from "../../src/gui-host/wire";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { snapshotSections, TestSocketClient } from "./test-client";

/** The schema default for a key, which a chosen value has to differ from to discriminate. */
function defaultTheme(key: "theme.dark" | "theme.light"): string {
	return SETTINGS_SCHEMA[key].default;
}

/** A relay nothing dials, distinguishable from the schema default at a glance. */
const RUNNING_RELAY = "wss://relay.set-on-the-running-store.invalid";

describe("a setting written from the window reaches what is already running", () => {
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;
	let state: SettingsTestState | undefined;
	let dir = "";

	beforeEach(async () => {
		state = beginSettingsTest();
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-running-settings-"));
		// The product never runs a settings action on an uninitialised process:
		// startup fills the slot first. Reproducing that is what makes the
		// branch under test reachable at all.
		await Settings.init({ cwd: dir, agentDir: dir });
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: dir, agentDir: dir });
		client = await TestSocketClient.connect(server.endpoint);
		await client.nextFrame();
		await client.nextFrame();
	});

	afterEach(async () => {
		client?.destroy();
		if (server) {
			await server.close();
			server = null;
		}
		restoreSettingsTestState(state);
		state = undefined;
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("a read states the value the process is acting on, not the one on disk", async () => {
		// Set without a flush: the running store holds it, the file does not.
		Settings.instance.set("collab.relayUrl", RUNNING_RELAY);

		const { frames } = await client.request(1, "LoadSettings");
		const settings = snapshotSections<Record<string, SettingEntryView>>(frames, "Settings").at(-1);

		expect(settings?.["collab.relayUrl"]?.value).toBe(RUNNING_RELAY);
	});

	test("a write changes the value the process is acting on", async () => {
		const { outcome } = await client.request(2, {
			SetSetting: { key: "collab.relayUrl", value: RUNNING_RELAY },
		});

		expect(outcome.RequestFailed).toBeUndefined();
		expect(Settings.instance.get("collab.relayUrl")).toBe(RUNNING_RELAY);
	});

	test("a reset returns the value the process is acting on to its default", async () => {
		const schemaDefault = SETTINGS_SCHEMA["collab.relayUrl"].default;
		Settings.instance.set("collab.relayUrl", RUNNING_RELAY);

		const { outcome } = await client.request(3, {
			ResetSetting: { key: "collab.relayUrl" },
		});

		expect(outcome.RequestFailed).toBeUndefined();
		expect(Settings.instance.get("collab.relayUrl")).toBe(schemaDefault);
	});

	test("the theme list names the themes the process is acting on", async () => {
		// Both grounds are moved off their defaults and neither is flushed, so
		// the list carries them only by reading the running store.
		const { frames: first } = await client.request(4, "LoadThemes");
		const installed = snapshotSections<ThemesView>(first, "Themes").at(-1)?.themes ?? [];
		const dark = installed.find(theme => theme.dark && theme.id !== defaultTheme("theme.dark"))?.id;
		const light = installed.find(theme => !theme.dark && theme.id !== defaultTheme("theme.light"))?.id;
		expect(dark).toBeDefined();
		expect(light).toBeDefined();
		Settings.instance.set("theme.dark", dark as string);
		Settings.instance.set("theme.light", light as string);

		const { frames } = await client.request(5, "LoadThemes");
		const themes = snapshotSections<ThemesView>(frames, "Themes").at(-1);

		expect(themes?.dark).toBe(dark);
		expect(themes?.light).toBe(light);
	});

	test("every settings action is one this suite has a decision for", () => {
		// Swept from the map rather than listed from memory, so an action added
		// to it lands here as a failure. Add the action to whichever list it
		// belongs to, and to a case above when it reads or writes the store.
		const readsOrWritesTheStore = ["LoadSettings", "SetSetting", "ResetSetting", "LoadThemes"];
		const actsOnTheAgentDirInstead = ["LoadKeybindings", "SetKeybinding"];

		expect(Object.keys(settingsActionHandlers).sort()).toEqual(
			[...readsOrWritesTheStore, ...actsOnTheAgentDirInstead].sort(),
		);
	});
});
