/**
 * Where `/login <provider>` leaves you when the browser round trip is over.
 *
 * THE CLASS. A login started from a COMMAND used to end at the composer: the transcript gained a
 * "Successfully logged in" receipt and nothing else happened. The account that was just stored, the
 * only reason the operator typed the command, was visible nowhere, and the surface that lists it
 * (`/account`) had to be opened as a separate step. The card's own `a` key already reopened the card
 * afterwards, so one of the two ways to add an account landed somewhere useful and the other did
 * not. The general class is a login path that does not report where it landed, and the members are
 * the call sites: `/login <provider>`, `/account login <provider>`, and the provider picker that
 * `/login` with no argument opens.
 *
 * WHAT THIS SUITE PINS.
 *
 *  1. A login that STORED a credential lands on the account manager for that provider, with the new
 *     account in the list. The list, not just the mount: a card that opened on the wrong provider,
 *     or before the registry saw the credential, would pass a mount-only assertion.
 *  2. A login that FAILED does not. An error plus a card claiming success is worse than the error
 *     alone, and "reopen unconditionally" is the obvious wrong fix — it is what the card's own `a`
 *     key does, and it is right there because the card is where you already were.
 *  3. A CANCELLED login does not, driven through the real dialog's Esc so the abort travels the
 *     path it travels in production (dialog aborts, the provider flow rejects, the catch sees
 *     `signal.aborted`). Cancel and failure reach the same `return false` by different routes, so a
 *     guard keyed on the error rather than the outcome passes one and fails the other.
 *  4. `/logout <provider>` lands on the SAME card, because choosing an account to remove needs the
 *     plan, the usage and the serving mark that only the card shows. Its refusals live in
 *     `selector-controller-logout.test.ts`.
 *  5. Every provider-facing sentence names the provider through `formatProviderName`, so the status
 *     line, the receipt and the card agree on the spelling.
 *
 * WHAT IT DOES NOT CATCH. `authStorage.login` is mocked, so no provider protocol is exercised: this
 * is about where control lands, not about whether a sign-in works. Which argument reaches
 * `showLogin` in the first place is the sibling contract, proven in
 * `test/slash-commands/login-names-a-provider-or-refuses.test.ts` against the real dispatcher.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { AuthStorage, type OAuthProvider, SqliteAuthCredentialStore } from "@veyyon/ai";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AccountManagerComponent } from "@veyyon/coding-agent/modes/components/account-manager";
import { LoginDialogComponent } from "@veyyon/coding-agent/modes/components/login-dialog";
import { SelectorController } from "@veyyon/coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { useIsolatedAgentDir } from "../../helpers/isolated-agent-dir";

useIsolatedAgentDir({ globalSettings: true });

const SESSION_ID = "session-command-login-test";
/** Esc, as a terminal sends it. The dialog matches it through the real keybinding table. */
const ESC = "\x1b";

let tempDir = "";
let store: SqliteAuthCredentialStore | undefined;
let authStorage: AuthStorage | undefined;

beforeAll(async () => {
	await initTheme();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-command-login-"));
	store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
	authStorage = new AuthStorage(store);
});

afterAll(async () => {
	store?.close();
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

function credential(email: string, accountId: string) {
	return {
		type: "oauth" as const,
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + 8 * 60 * 60_000,
		accountId,
		email,
	};
}

/** What the provider does when the browser round trip finishes. */
type Outcome = "stores" | "fails" | "cancelled";

interface Harness {
	/** Every account manager the controller mounted. Empty is the composer. */
	readonly cards: AccountManagerComponent[];
	readonly cardText: () => string;
	/** Everything written to the transcript, which is where the login receipt goes. */
	readonly presented: () => string;
	readonly statuses: string[];
	readonly showError: ReturnType<typeof vi.fn>;
	/** Resolves once the mocked provider flow has started and the dialog is on screen. */
	readonly loginStarted: Promise<void>;
	readonly dialog: () => LoginDialogComponent;
	readonly login: (providerId?: string) => Promise<void>;
	readonly logout: (providerId?: string) => Promise<void>;
}

async function harness(outcome: Outcome): Promise<Harness> {
	const storage = authStorage;
	if (!storage) throw new Error("no auth storage");
	vi.restoreAllMocks();
	// Health probing is an HTTP call per credential and has nothing to do with this contract.
	vi.spyOn(storage, "checkCredentials").mockResolvedValue([]);
	await storage.set("anthropic", [credential("first@example.com", "acct-first")]);

	const started = Promise.withResolvers<void>();
	vi.spyOn(storage, "login").mockImplementation((async (provider: OAuthProvider, options: { signal: AbortSignal }) => {
		started.resolve();
		if (outcome === "fails") throw new Error("provider refused");
		if (outcome === "cancelled") {
			// The real shape of a cancel: the flow stays open until the dialog's signal fires, then
			// rejects. Resolving early would make the abort unobservable and the test green by luck.
			const aborted = Promise.withResolvers<never>();
			options.signal.addEventListener("abort", () => aborted.reject(new Error("Login cancelled")));
			return aborted.promise;
		}
		await storage.set("anthropic", [
			credential("first@example.com", "acct-first"),
			credential("second@example.com", "acct-second"),
		]);
		return { type: "oauth" as const, email: "second@example.com", provider };
	}) as unknown as AuthStorage["login"]);

	const cards: AccountManagerComponent[] = [];
	const dialogs: LoginDialogComponent[] = [];
	const presented: string[] = [];
	const statuses: string[] = [];
	const showError = vi.fn();
	const ctx = {
		editorContainer: {
			children: [],
			clear: () => {},
			addChild: (child: unknown) => {
				if (child instanceof LoginDialogComponent) dialogs.push(child);
			},
		},
		editor: {},
		oauthManualInput: { waitForInput: async () => "", clear: () => {} },
		present: vi.fn((component: { render: (width: number) => string[] }) => {
			presented.push(component.render(200).join("\n"));
		}),
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
			modelRegistry: {
				authStorage: storage,
				refresh: vi.fn(async () => undefined),
				refreshInBackground: vi.fn(),
			},
			fetchUsageReports: async () => [],
		},
		showStatus: vi.fn((message: string) => {
			statuses.push(message);
		}),
		showWarning: vi.fn(),
		showError,
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
	} as unknown as InteractiveModeContext;

	const controller = new SelectorController(ctx);
	return {
		cards,
		cardText: () =>
			cards
				.map(card =>
					card
						.render(200)
						.map(line => stripVTControlCharacters(line))
						.join("\n"),
				)
				.join("\n"),
		presented: () => stripVTControlCharacters(presented.join("\n")),
		statuses,
		showError,
		loginStarted: started.promise,
		dialog: () => {
			const dialog = dialogs[dialogs.length - 1];
			if (!dialog) throw new Error("no login dialog was mounted");
			return dialog;
		},
		login: providerId => controller.showLogin(providerId),
		logout: providerId => controller.showLogout(providerId),
	};
}

describe("a login started from a command", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * The contract: the command that added an account shows you the account it added, on the card
	 * that owns them. Both halves are asserted because a card mounted before the registry saw the
	 * credential renders the old list and would satisfy a mount-only check.
	 */
	it("lands on the account manager for that provider with the new account listed", async () => {
		const calls = await harness("stores");

		await calls.login("anthropic");

		expect(calls.cards).toHaveLength(1);
		const text = calls.cardText();
		expect(text).toContain("second@example.com");
		expect(text).toContain("first@example.com");
		expect(text).toContain("Anthropic");
	});

	/** Every sentence about the provider uses the one spelling the rest of the product shows. */
	it("names the provider the way the card names it", async () => {
		const calls = await harness("stores");

		await calls.login("anthropic");

		expect(calls.statuses).toContain("Logging in to Anthropic…");
		expect(calls.presented()).toContain("Successfully logged in to Anthropic as second@example.com");
	});

	/** A failure reports the failure and changes nothing about where you are. */
	it("stays at the composer when the login failed", async () => {
		const calls = await harness("fails");

		await calls.login("anthropic");

		expect(calls.cards).toHaveLength(0);
		expect(calls.showError).toHaveBeenCalledTimes(1);
		expect(String(calls.showError.mock.calls[0]?.[0])).toContain("Login failed");
	});

	/**
	 * Esc during the flow is not a login. Driven through the dialog rather than by rejecting the
	 * mock, so the abort reaches the provider flow the way it does in production; a guard that
	 * inspected the error text instead of the outcome would pass the failure case and mount a card
	 * here.
	 */
	it("stays at the composer when the login was cancelled", async () => {
		const calls = await harness("cancelled");

		const running = calls.login("anthropic");
		await calls.loginStarted;
		calls.dialog().handleInput(ESC);
		await running;

		expect(calls.cards).toHaveLength(0);
		expect(calls.showError).not.toHaveBeenCalled();
	});

	/**
	 * The logout half of the same pair of commands lands on the SAME card, because choosing which
	 * account to remove needs everything the card shows and nothing a bare label list can show. The
	 * card is asserted to carry both accounts: a card mounted on the wrong provider, or before the
	 * store was read, would satisfy a mount-only check.
	 */
	it("lands on the same account manager for logout", async () => {
		const calls = await harness("stores");

		await calls.logout("anthropic");

		expect(calls.cards).toHaveLength(1);
		expect(calls.cardText()).toContain("first@example.com");
		expect(calls.showError).not.toHaveBeenCalled();
	});
});
