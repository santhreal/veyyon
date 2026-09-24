/**
 * WHY THIS SUITE EXISTS
 *
 * The capability snapshot is written when a window connects, before this
 * process has a session to read settings from, so it answers from the schema
 * defaults. Nothing stated it again afterwards. A window running under a
 * profile that turned `stt.enabled` on was told `Dictation` was `Unavailable`
 * for the whole life of the connection, and the composer drew the microphone
 * greyed with the reason for a setting that was on; `goal.enabled` and `Goals`
 * had the same fault. It was found while photographing the microphone in both
 * states, where the two arms produced frames that differed nowhere in the
 * composer.
 *
 * THE CLASS THIS CLOSES. Every capability a setting withholds is swept from
 * `SETTING_GATED_CAPABILITIES` at run time and driven through the two points a
 * window reads one after the connect frame: the session this process builds
 * for it, and a write to that setting from the settings screen. A capability
 * added to that list arrives here with the same cases and no edit to this
 * file, and a declaration whose path is not a boolean setting fails rather
 * than being swept silently past.
 *
 * WHAT IT DOES NOT CATCH. What the window draws once it holds the snapshot,
 * which is the desktop's own projection of a gate onto a control and is
 * asserted by
 * `crates/veyyon-desktop/tests/a-control-is-withheld-by-the-capability-it-is-gated-by.rs`.
 * Nor the connect frame itself, which answers from the
 * declared defaults by design and is covered in
 * `a-window-dictates-into-its-own-composer.test.ts`. The sweep reads
 * `SETTING_GATED_CAPABILITIES`, which is the only place a setting withholds a
 * capability today, so a capability withheld by some other run-time state
 * would be outside it and needs its own re-state and its own case here.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { SETTINGS_SCHEMA } from "../../src/config/settings-schema";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import { CAPABILITY_GATING_SETTINGS, SETTING_GATED_CAPABILITIES } from "../../src/gui-host/session-bridge";
import type { Capability, CapabilityStatus } from "../../src/gui-host/wire";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { type RequestFrame, snapshotSections, TestSocketClient } from "./test-client";

type CapabilityList = [Capability, CapabilityStatus][];

/** The status a gated capability holds while its setting reads `enabled`. */
function expected(reason: string, enabled: boolean): CapabilityStatus {
	return enabled ? "Available" : { Unavailable: { reason } };
}

/** What the last capability list in `frames` states for one capability. */
function stated(frames: RequestFrame[], capability: Capability): CapabilityStatus | undefined {
	const list = snapshotSections<CapabilityList>(frames, "Capabilities").at(-1);
	return list?.find(([name]) => name === capability)?.[1];
}

describe("a capability a setting withholds follows that setting", () => {
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;
	let state: SettingsTestState | undefined;
	let dir = "";

	beforeEach(async () => {
		state = beginSettingsTest();
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-gated-capability-"));
		await Settings.init({ cwd: dir, agentDir: dir });
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: dir, agentDir: dir });
		client = await TestSocketClient.connect(server.endpoint);
		// The two frames a connection opens with, including the capability
		// list answered from the defaults. Every assertion below is about a
		// list stated after these.
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

	test("every gated capability names a boolean setting these cases can move", () => {
		expect(SETTING_GATED_CAPABILITIES.length).toBeGreaterThan(0);
		for (const gate of SETTING_GATED_CAPABILITIES) {
			expect(SETTINGS_SCHEMA[gate.path]).toBeDefined();
			expect(typeof SETTINGS_SCHEMA[gate.path].default).toBe("boolean");
			// The sentence states the setting to change, which is the only
			// corrective action a refused capability leaves open.
			expect(gate.reason).toContain(gate.path);
		}
		expect([...CAPABILITY_GATING_SETTINGS].sort()).toEqual(SETTING_GATED_CAPABILITIES.map(gate => gate.path).sort());
	});

	for (const gate of SETTING_GATED_CAPABILITIES) {
		const off = SETTINGS_SCHEMA[gate.path].default as boolean;
		const on = !off;

		test(`${gate.capability} follows ${gate.path} into the session this process builds`, async () => {
			Settings.instance.set(gate.path, on as never);
			await Settings.instance.flush();

			// The first action that needs a session builds one, and the
			// session carries the settings the connect frame could not read.
			const { frames } = await client.request(1, { GetUsage: {} });

			expect(stated(frames, gate.capability)).toEqual(expected(gate.reason, on));
		});

		test(`${gate.capability} follows ${gate.path} when the window writes it`, async () => {
			const written = await client.request(2, {
				SetSetting: { key: gate.path, value: on },
			});
			expect(written.outcome.RequestFailed).toBeUndefined();
			expect(stated(written.frames, gate.capability)).toEqual(expected(gate.reason, on));

			const back = await client.request(3, {
				SetSetting: { key: gate.path, value: off },
			});
			expect(stated(back.frames, gate.capability)).toEqual(expected(gate.reason, off));
		});

		test(`${gate.capability} follows ${gate.path} when the window resets it`, async () => {
			Settings.instance.set(gate.path, on as never);
			await Settings.instance.flush();

			const { outcome, frames } = await client.request(4, {
				ResetSetting: { key: gate.path },
			});

			expect(outcome.RequestFailed).toBeUndefined();
			expect(stated(frames, gate.capability)).toEqual(expected(gate.reason, off));
		});
	}
});
