/**
 * WHY: the terminal's `/extensions` dashboard lists every skill, rule, hook,
 * tool and extension module the discovery layer finds, and switches an item
 * or a whole source off by writing `disabledExtensions` and
 * `disabledProviders`. A window had neither the list nor the switches, so an
 * item that misbehaved in a desktop session could only be switched off from a
 * terminal.
 *
 * This suite drives the real host over its socket, with a discovery source
 * registered for the test so the item it provides is known, and defends:
 * 1. `RefreshExtensions` lists the item and its source in the states the
 *    terminal's loader reports.
 * 2. `SetExtensionEnabled` writes the switch to `disabledExtensions`, where the
 *    terminal's dashboard reads it, and answers with the item's new state;
 *    switching it back on removes the entry.
 * 3. `SetExtensionSourceEnabled` switches the whole source in the discovery
 *    layer and `disabledProviders`, withholding every item it provides, and
 *    switching it back on restores them.
 * 4. An item or a source that is not listed is refused in the `Extension`
 *    scope and writes nothing.
 *
 * Not caught: MCP server rows, whose switch writes the MCP configuration and
 * which `extension-dashboard-mcp-parity.test.ts` owns through the same
 * `setMcpServerEnabled` call; and whether a running session reloads a
 * switched item, which the session's own discovery suites own.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { reset as resetDiscoveryCache } from "../../src/discovery";
import {
	captureRegistryForTests,
	isProviderEnabled,
	type RegistrySnapshot,
	registerProvider,
	restoreRegistryForTests,
} from "../../src/discovery/capability";
import type { DiscoveredSkill } from "../../src/discovery/capability/skill";
import { loadAllExtensions } from "../../src/extensibility/extension-state/state-manager";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { ExtensionItemView, ExtensionSourceView, ExtensionsView } from "../../src/gui-host/wire";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { type RequestFrame, snapshotSections, TestSocketClient } from "./test-client";

const SOURCE = "window-switch-source";
const SOURCE_NAME = "Window Switch Source";
const SKILL = "window-switch-skill";
const SKILL_ID = `skill:${SKILL}`;
const SKILL_PATH = `/skills/${SKILL}/SKILL.md`;

/** The last `Extensions` section a request's frames carried. */
function extensionsIn(frames: RequestFrame[]): ExtensionsView {
	const view = snapshotSections<ExtensionsView>(frames, "Extensions").at(-1);
	if (!view) throw new Error("the host answered with no Extensions section");
	return view;
}

function skillIn(frames: RequestFrame[]): ExtensionItemView | undefined {
	return extensionsIn(frames).items.find(item => item.id === SKILL_ID);
}

function sourceIn(frames: RequestFrame[]): ExtensionSourceView | undefined {
	return extensionsIn(frames).sources.find(source => source.id === SOURCE);
}

describe("an extension the window switches off is off for the terminal too", () => {
	let dir = "";
	let state: SettingsTestState | undefined;
	let registry: RegistrySnapshot | undefined;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;

	beforeEach(async () => {
		state = beginSettingsTest();
		registry = captureRegistryForTests();
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-extensions-"));
		await Settings.init({ cwd: dir, agentDir: dir });
		registerProvider<DiscoveredSkill>("skills", {
			id: SOURCE,
			displayName: SOURCE_NAME,
			description: "A source registered by this suite",
			priority: 100,
			load: async () => ({
				items: [
					{
						name: SKILL,
						path: SKILL_PATH,
						content: "Skill content",
						level: "user",
						frontmatter: { description: "A skill this suite switches" },
						_source: { provider: SOURCE, providerName: SOURCE_NAME, path: SKILL_PATH, level: "user" },
					},
				],
				warnings: [],
			}),
		});
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: dir,
			agentDir: dir,
			authStorage: await isolatedAuthStorage(dir),
		});
		client = await TestSocketClient.connect(server.endpoint);
	});

	afterEach(async () => {
		client?.destroy();
		if (server) {
			await server.close();
			server = null;
		}
		if (registry) restoreRegistryForTests(registry);
		registry = undefined;
		resetDiscoveryCache();
		restoreSettingsTestState(state);
		state = undefined;
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("the list states the item and its source as the terminal's loader reads them", async () => {
		const { frames, outcome } = await client.request(1, "RefreshExtensions");
		expect(outcome).toEqual({ RequestSucceeded: { request: 1 } });

		expect(skillIn(frames)).toEqual({
			id: SKILL_ID,
			kind: "skill",
			name: SKILL,
			description: "A skill this suite switches",
			trigger: null,
			path: SKILL_PATH,
			source: SOURCE,
			level: "user",
			state: "Active",
			shadowed_by: null,
		});
		expect(sourceIn(frames)).toEqual({ id: SOURCE, name: SOURCE_NAME, enabled: true });
		const terminal = await loadAllExtensions(dir, [...Settings.instance.get("disabledExtensions")]);
		expect(extensionsIn(frames).items.map(item => item.id)).toEqual(terminal.map(row => row.id));
	});

	test("an item switched off is written where the terminal's dashboard reads it", async () => {
		const off = await client.request(2, { SetExtensionEnabled: { id: SKILL_ID, enabled: false } });
		expect(off.outcome).toEqual({ RequestSucceeded: { request: 2 } });
		expect(skillIn(off.frames)?.state).toBe("Disabled");
		expect(Settings.instance.get("disabledExtensions")).toEqual([SKILL_ID]);
		const terminal = await loadAllExtensions(dir, [...Settings.instance.get("disabledExtensions")]);
		expect(terminal.find(row => row.id === SKILL_ID)?.disabledReason).toBe("item-disabled");

		const on = await client.request(3, { SetExtensionEnabled: { id: SKILL_ID, enabled: true } });
		expect(on.outcome).toEqual({ RequestSucceeded: { request: 3 } });
		expect(skillIn(on.frames)?.state).toBe("Active");
		expect(Settings.instance.get("disabledExtensions")).toEqual([]);
	});

	test("a source switched off withholds its items until it is switched back on", async () => {
		const off = await client.request(4, { SetExtensionSourceEnabled: { source: SOURCE, enabled: false } });
		expect(off.outcome).toEqual({ RequestSucceeded: { request: 4 } });
		expect(sourceIn(off.frames)?.enabled).toBe(false);
		expect(skillIn(off.frames)).toBeUndefined();
		expect(isProviderEnabled(SOURCE)).toBe(false);
		expect(Settings.instance.get("disabledProviders")).toContain(SOURCE);

		const on = await client.request(5, { SetExtensionSourceEnabled: { source: SOURCE, enabled: true } });
		expect(on.outcome).toEqual({ RequestSucceeded: { request: 5 } });
		expect(sourceIn(on.frames)?.enabled).toBe(true);
		expect(skillIn(on.frames)?.state).toBe("Active");
		expect(Settings.instance.get("disabledProviders")).not.toContain(SOURCE);
	});

	test("an item or a source that is not listed is refused and writes nothing", async () => {
		const item = await client.request(6, { SetExtensionEnabled: { id: "skill:not-listed", enabled: false } });
		expect(item.outcome.RequestFailed?.error).toMatchObject({ scope: "Extension", code: "EXTENSION_NOT_FOUND" });

		const source = await client.request(7, { SetExtensionSourceEnabled: { source: "not-listed", enabled: false } });
		expect(source.outcome.RequestFailed?.error).toMatchObject({
			scope: "Extension",
			code: "EXTENSION_SOURCE_NOT_FOUND",
		});

		expect(Settings.instance.get("disabledExtensions")).toEqual([]);
		expect(Settings.instance.get("disabledProviders")).not.toContain("not-listed");
	});
});
