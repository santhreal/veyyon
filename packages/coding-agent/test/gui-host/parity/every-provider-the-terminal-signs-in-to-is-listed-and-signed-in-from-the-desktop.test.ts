/**
 * WHY: a provider the terminal can sign in to but the desktop does not list is a
 * provider whose models a window can never select, and a login kind the host
 * cannot drive for a window is a sign-in that never finishes there. This sweep
 * enumerates every provider the OAuth list, the provider registry and the
 * catalog declare, asks the real `RefreshProviders` handler which it publishes,
 * and fails when a provider is missing from that list without a recorded gap or
 * when a provider's login kind has no carrier.
 *
 * Not caught: a login that calls `onManualCodeInput` or `onSuccessPage`, which
 * the host's controller does not implement; and the `disabledProviders` setting,
 * which the terminal's sign-in list honours and the host's list does not read.
 */
import { describe, expect, it } from "bun:test";
import { providersActionHandlers } from "../../../src/gui-host/actions/providers";
import type { ActionContext } from "../../../src/gui-host/actions/types";
import { membersCarriedBy } from "../../../src/gui-host/desktop-parity/carrier";
import {
	PROVIDER_GAPS,
	PROVIDER_LOGIN_CARRIERS,
	providerCarrier,
	providerLoginKind,
	terminalProviderIds,
} from "../../../src/gui-host/desktop-parity/models";
import type { SnapshotSection } from "../../../src/gui-host/wire";

/** The provider ids the host's `RefreshProviders` publishes to a window. */
async function providersTheHostLists(): Promise<Set<string>> {
	const refresh = providersActionHandlers.RefreshProviders;
	if (!refresh) throw new Error("RefreshProviders has no handler");
	const listed = new Set<string>();
	const ctx = {
		authStorage: async () => ({ hasAuth: () => false }),
		reply: {
			snapshot: (section: SnapshotSection) => {
				if ("Providers" in section) for (const provider of section.Providers) listed.add(provider.id);
			},
			success: () => {},
			failure: (error: { message: string }) => {
				throw new Error(error.message);
			},
		},
	} as unknown as ActionContext;
	await refresh(ctx, undefined as never);
	return listed;
}

describe("providers on the desktop", () => {
	it("lists every provider the terminal can sign in to, less the recorded gaps", async () => {
		const providers = terminalProviderIds(new Set());
		const listed = await providersTheHostLists();
		expect(providers.filter(id => !listed.has(id))).toEqual(Object.keys(PROVIDER_GAPS).sort());
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
