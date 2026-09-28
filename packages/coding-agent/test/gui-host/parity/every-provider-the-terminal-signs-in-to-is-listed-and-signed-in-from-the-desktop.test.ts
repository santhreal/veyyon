/**
 * WHY: a provider the terminal can sign in to but the desktop does not list is a
 * provider whose models a window can never select, and a login kind the host
 * cannot drive for a window is a sign-in that never finishes there. This sweep
 * enumerates every provider the OAuth list, the provider registry and the
 * catalog declare, asks the real host's `RefreshProviders` over its socket
 * which it publishes, and fails when a provider is missing from that list
 * without a recorded gap or when a provider's login kind has no carrier. The
 * terminal's sign-in list leaves out the providers the `disabledProviders`
 * setting names, and so must the host's.
 *
 * Not caught: whether a login kind's carrier finishes that kind of login end
 * to end, which `a-login-that-asks-for-a-pasted-code-is-answered-from-the-window`
 * owns for the paste-code flows.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../../src/config/settings";
import { type GuiHostServer, startGuiHostServer } from "../../../src/gui-host";
import { membersCarriedBy } from "../../../src/gui-host/desktop-parity/carrier";
import {
	PROVIDER_GAPS,
	PROVIDER_LOGIN_CARRIERS,
	providerCarrier,
	providerLoginKind,
	terminalProviderIds,
} from "../../../src/gui-host/desktop-parity/models";
import type { ProviderView } from "../../../src/gui-host/wire";
import { isolatedAuthStorage } from "../../helpers/isolated-auth-storage";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../../helpers/settings-test-state";
import { snapshotSections, TestSocketClient } from "../test-client";

describe("providers on the desktop", () => {
	let dir = "";
	let state: SettingsTestState | undefined;
	let server: GuiHostServer | null = null;

	beforeEach(async () => {
		state = beginSettingsTest();
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-provider-parity-"));
		await Settings.init({ cwd: dir, agentDir: dir });
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: dir,
			agentDir: dir,
			authStorage: await isolatedAuthStorage(dir),
		});
	});

	afterEach(async () => {
		if (server) {
			await server.close();
			server = null;
		}
		restoreSettingsTestState(state);
		state = undefined;
		await fs.rm(dir, { recursive: true, force: true });
	});

	/** The provider ids the host's `RefreshProviders` publishes to a window. */
	async function providersTheHostLists(): Promise<Set<string>> {
		if (!server) throw new Error("no host is running");
		const client = await TestSocketClient.connect(server.endpoint);
		try {
			const { frames, outcome } = await client.request(1, "RefreshProviders");
			if (outcome.RequestFailed) throw new Error(outcome.RequestFailed.error.message);
			const [listed] = snapshotSections<ProviderView[]>(frames, "Providers");
			return new Set(listed?.map(provider => provider.id));
		} finally {
			client.destroy();
		}
	}

	it("lists every provider the terminal can sign in to, less the recorded gaps", async () => {
		const providers = terminalProviderIds(new Set());
		const listed = await providersTheHostLists();
		expect(providers.filter(id => !listed.has(id))).toEqual(Object.keys(PROVIDER_GAPS).sort());
	});

	it("leaves out of the list the providers the terminal's sign-in list leaves out", async () => {
		const [first, second] = terminalProviderIds(new Set());
		const disabled = new Set([first, second]);
		Settings.instance.set("disabledProviders", [...disabled]);
		await Settings.instance.flush();

		const listed = await providersTheHostLists();

		expect([...listed].filter(id => disabled.has(id))).toEqual([]);
		expect(terminalProviderIds(disabled).filter(id => !listed.has(id))).toEqual(Object.keys(PROVIDER_GAPS).sort());
	});

	it("decides every login kind a provider uses, and only those", () => {
		const providers = terminalProviderIds(new Set());
		const kinds = [...new Set(providers.map(providerLoginKind))].sort();
		expect(kinds).toEqual(Object.keys(PROVIDER_LOGIN_CARRIERS).sort());
		expect(providers.filter(id => providerCarrier(id) === undefined)).toEqual([]);
	});

	it("records no login kind as an opt-out or a gap, and no provider gap", () => {
		expect(membersCarriedBy(PROVIDER_LOGIN_CARRIERS, "optOut")).toEqual([]);
		expect(membersCarriedBy(PROVIDER_LOGIN_CARRIERS, "gap")).toEqual([]);
		expect(Object.keys(PROVIDER_GAPS)).toEqual([]);
	});

	it("leaves a provider the settings disable out of the members", () => {
		const [first] = terminalProviderIds(new Set());
		expect(terminalProviderIds(new Set([first]))).not.toContain(first);
	});
});
