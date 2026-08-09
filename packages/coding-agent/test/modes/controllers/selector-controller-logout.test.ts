/**
 * Where `/logout` puts you, and what it refuses to do.
 *
 * THE CLASS. Logging out is choosing an ACCOUNT, and the account card is the only surface that says
 * what each account is: its plan, its usage, whether it serves this session and whether it is the
 * one the operator chose. `/logout` therefore lands on the card, exactly as `/logout` with a
 * provider and `/account` do, and the card's own armed `x` performs the removal through the single
 * reporter that names the account, the file it left, and any auth source still standing. The class
 * of defect being closed is a destructive command that offers a bare list of labels: the operator
 * picks a name with no way to tell two subscriptions apart, and the first key offered is the one
 * that deletes.
 *
 * WHAT THIS SUITE PINS.
 *
 *  1. `/logout <provider>` with stored credentials mounts the account card on that provider.
 *  2. The card removes ONLY the row under the cursor, and the receipt names that account, the auth
 *     database it left, and the fact that the model registry was refreshed afterwards.
 *  3. `/logout <provider>` with nothing stored refuses, and the refusal names where the provider's
 *     auth actually comes from instead of stopping at "no". A refusal that only says no is what
 *     this command used to print, and it left the operator with no next move.
 *  4. `/logout` with nothing stored anywhere refuses once, at status level, and names env and config
 *     as the places to remove it. It must not mount a card listing nothing.
 *  5. An api-key provider is named the way every other surface names it (`Groq`, never the slug),
 *     because `/logout groq` reaches the same card and the same reporter.
 *
 * WHAT IT DOES NOT CATCH. The card's own rendering is proven in
 * `test/modes/components/account-manager.test.ts`; this suite drives the real component but asserts
 * on the removal and the report, not on the frame. Whether the removal reaches the database is the
 * store's contract, exercised here through a real `SqliteAuthCredentialStore` rather than a fake.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { type AuthCredential, AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AccountManagerComponent } from "@veyyon/coding-agent/modes/components/account-manager";
import { SelectorController } from "@veyyon/coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { useIsolatedAgentDir } from "../../helpers/isolated-agent-dir";

useIsolatedAgentDir({ globalSettings: true });

const SESSION_ID = "session-logout-test";
/** Arrow down, as a terminal sends it. */
const DOWN = "\x1b[B";

/**
 * The card's `x` fires the removal without awaiting it, which is what production does: the keypress
 * returns and the report arrives when the store answers. Bounded so a removal that never happens
 * fails as a timeout naming the condition rather than as a mismatched id list.
 */
async function until(what: string, done: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (done()) return;
		await sleep(5);
	}
	throw new Error(`timed out waiting for ${what}`);
}

let tempDir = "";
let store: SqliteAuthCredentialStore | undefined;
let authStorage: AuthStorage | undefined;

beforeAll(async () => {
	await initTheme();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-logout-card-"));
	store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
	authStorage = new AuthStorage(store);
});

afterAll(async () => {
	store?.close();
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

afterEach(() => {
	vi.restoreAllMocks();
});

function oauth(email: string, accountId: string): AuthCredential {
	return {
		type: "oauth",
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + 8 * 60 * 60_000,
		accountId,
		email,
	};
}

interface Harness {
	readonly controller: SelectorController;
	readonly storage: AuthStorage;
	/** Every overlay the controller mounted. Empty means the operator stayed at the composer. */
	readonly cards: AccountManagerComponent[];
	readonly card: () => AccountManagerComponent;
	readonly presented: () => string;
	readonly statuses: string[];
	readonly errors: string[];
	readonly refresh: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

async function harness(seed: { provider: string; credentials: AuthCredential[] }): Promise<Harness> {
	const storage = authStorage;
	if (!storage) throw new Error("no auth storage");
	// Health and usage are network round trips and say nothing about a removal.
	vi.spyOn(storage, "checkCredentials").mockResolvedValue([]);
	for (const provider of ["anthropic", "groq"]) {
		await storage.set(provider, provider === seed.provider ? seed.credentials : []);
	}

	const cards: AccountManagerComponent[] = [];
	const presented: string[] = [];
	const statuses: string[] = [];
	const errors: string[] = [];
	const refresh = vi.fn(async () => undefined);
	const ctx = {
		editor: {},
		editorContainer: { children: [], clear: () => {}, addChild: () => {} },
		ui: {
			setFocus: vi.fn(),
			requestRender: vi.fn(),
			requestComponentRender: vi.fn(),
			showOverlay: vi.fn((component: unknown) => {
				if (component instanceof AccountManagerComponent) cards.push(component);
				return { hide: vi.fn() };
			}),
		},
		session: {
			sessionId: SESSION_ID,
			settings: Settings.instance,
			modelRegistry: { authStorage: storage, refresh },
			fetchUsageReports: async () => [],
		},
		present: vi.fn((component: { render: (width: number) => readonly string[] }) => {
			presented.push(component.render(200).join("\n"));
		}),
		showStatus: vi.fn((message: string) => {
			statuses.push(message);
		}),
		showWarning: vi.fn(),
		showError: vi.fn((message: string) => {
			errors.push(message);
		}),
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
	} as unknown as InteractiveModeContext;

	return {
		controller: new SelectorController(ctx),
		storage,
		cards,
		card: () => {
			const card = cards[cards.length - 1];
			if (!card) throw new Error("no account card was mounted");
			return card;
		},
		presented: () => stripVTControlCharacters(presented.join("\n")),
		statuses,
		errors,
		refresh,
	};
}

describe("/logout lands in the account card", () => {
	it("mounts the card for the provider it was given", async () => {
		const h = await harness({
			provider: "anthropic",
			credentials: [oauth("a@example.com", "acct-a"), oauth("b@example.com", "acct-b")],
		});

		await h.controller.showLogout("anthropic");

		expect(h.cards).toHaveLength(1);
		const frame = h
			.card()
			.render(200)
			.map(line => stripVTControlCharacters(line))
			.join("\n");
		expect(frame).toContain("a@example.com");
		expect(frame).toContain("b@example.com");
		expect(frame).toContain("Anthropic");
		expect(h.errors).toEqual([]);
	});

	/**
	 * The removal contract, driven through the card's real armed `x`: one keypress arms, the second
	 * performs. Only the row under the cursor leaves, and the report carries the two facts a status
	 * toast kept dropping — which account left, and which file it left.
	 */
	it("removes only the account under the cursor and says which file it left", async () => {
		const h = await harness({
			provider: "anthropic",
			credentials: [oauth("a@example.com", "acct-a"), oauth("b@example.com", "acct-b")],
		});
		const before = h.storage.listStoredCredentials("anthropic").map(row => row.id);
		expect(before).toHaveLength(2);

		await h.controller.showLogout("anthropic");
		h.card().handleInput(DOWN);
		h.card().handleInput("x");
		h.card().handleInput("x");
		// The report is the LAST step of a removal (store write, registry refresh, transcript block),
		// so waiting on the store alone would observe a half-finished logout.
		await until("the logout report to be printed", () => h.presented().length > 0);

		expect(h.storage.listStoredCredentials("anthropic").map(row => row.id)).toEqual([before[0]]);
		const report = h.presented();
		expect(report).toContain("Successfully logged out b@example.com from Anthropic");
		expect(report).toContain("Credential removed from");
		expect(h.refresh).toHaveBeenCalled();
		expect(h.errors).toEqual([]);
	});

	/**
	 * The first refusal the card cannot state: there is nothing stored to choose from. It names the
	 * source the auth actually comes from, because that is the only place a removal could happen.
	 */
	it("refuses a provider with nothing stored, and names where its auth comes from", async () => {
		const h = await harness({ provider: "anthropic", credentials: [] });
		vi.spyOn(h.storage, "describeCredentialSource").mockReturnValue("the ANTHROPIC_API_KEY environment variable");

		await h.controller.showLogout("anthropic");

		expect(h.cards).toEqual([]);
		expect(h.errors).toEqual([
			"Logout skipped: no stored credentials for Anthropic. Current auth comes from the ANTHROPIC_API_KEY environment variable; remove that source to log out.",
		]);
	});

	/** With no source to name, the refusal still stands and still says nothing was stored. */
	it("refuses a provider with nothing stored even when no other auth source exists", async () => {
		const h = await harness({ provider: "anthropic", credentials: [] });
		vi.spyOn(h.storage, "describeCredentialSource").mockReturnValue(undefined);

		await h.controller.showLogout("anthropic");

		expect(h.cards).toEqual([]);
		expect(h.errors).toEqual(["Logout skipped: no stored credentials for Anthropic."]);
	});

	/**
	 * `/logout` with no provider and nothing stored anywhere. A card listing no accounts would be a
	 * screen the operator cannot act on, so this refuses at status level and names the two places
	 * auth can still come from.
	 */
	it("refuses a bare logout when nothing is stored at all", async () => {
		const h = await harness({ provider: "anthropic", credentials: [] });

		await h.controller.showLogout();

		expect(h.cards).toEqual([]);
		expect(h.statuses).toEqual([
			"No stored provider credentials to log out. Remove env or config auth at its source.",
		]);
	});

	/**
	 * The provider with no browser login at all. `/logout groq` used to be refused outright; when it
	 * was allowed through, the dedicated picker printed the raw slug `groq` in its title while the
	 * card, the status line and every message around it said `Groq`. One card means one spelling.
	 */
	it("names an api-key provider the way every other surface names it", async () => {
		const h = await harness({
			provider: "groq",
			credentials: [{ type: "api_key", key: "gsk-logout-card-test" }],
		});

		await h.controller.showLogout("groq");

		expect(h.cards).toHaveLength(1);
		const frame = h
			.card()
			.render(200)
			.map(line => stripVTControlCharacters(line))
			.join("\n");
		expect(frame).toContain("Groq");
		expect(frame).not.toContain("groq");
		expect(h.errors).toEqual([]);
	});

	/**
	 * A provider the operator DISABLED can still hold a credential, and a credential you cannot
	 * reach is a credential you cannot remove. The old logout picker filtered nothing for exactly
	 * this reason; the card gets there differently, by listing every provider the credential store
	 * reports rather than every provider still enabled, so the guarantee has to be pinned on the card
	 * or the next filter added to the sidebar takes it away silently.
	 */
	it("still reaches an account whose provider has been disabled", async () => {
		const h = await harness({
			provider: "anthropic",
			credentials: [oauth("disabled@example.com", "acct-disabled")],
		});
		const previous = Settings.instance.get("disabledProviders");
		Settings.instance.set("disabledProviders", ["anthropic"]);
		try {
			await h.controller.showLogout("anthropic");

			expect(h.cards).toHaveLength(1);
			const frame = h
				.card()
				.render(200)
				.map(line => stripVTControlCharacters(line))
				.join("\n");
			expect(frame).toContain("disabled@example.com");
			expect(h.errors).toEqual([]);
		} finally {
			Settings.instance.set("disabledProviders", previous);
		}
	});
});
