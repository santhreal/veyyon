/**
 * `a` on the account card is a round trip, not an exit.
 *
 * WHY THIS SUITE EXISTS. The card's whole job is to show which of several accounts is stored and
 * which one is spending. Its `+ add another …` entry called `done()` and then started a login, so
 * the surface that answers "did that work, and is it selected" was torn down before the login it
 * started had even opened: a user who pressed `a`, signed in, and looked up found the composer, with
 * the new account visible nowhere. The one affordance for GETTING a second account was also the one
 * that guaranteed you could not see the result of using it. That is the seam between "the login
 * system" and "the account manager", and it was not joined.
 *
 * WHAT IS PINNED HERE:
 *
 *  - Pressing `a` starts a login for the provider the card was showing, not for a provider picker.
 *    The card already knows which provider the cursor is on, so a second choice would be a step the
 *    user already took.
 *  - When the login lands, an account card is open again, on that provider, listing the credential
 *    the login stored. This is the assertion the old code could not pass.
 *  - A login that fails returns to the card too. The helper deliberately does not branch on the
 *    login's outcome: escape unwinds ONE level, so abandoning the login returns you to the surface
 *    that offered it. Both reachable outcomes (stored / failed) are driven here, and the reopen is
 *    asserted for both.
 *  - Both entry points do it. `a` and `enter` on the `+ add another …` row are separate call sites
 *    in the component, and wiring only the keypress is how one of them silently keeps the old
 *    behaviour.
 *  - A login does NOT move the session's traffic. With load balancing off, the selected credential
 *    decides what gets spent; signing in to a second account is not a request to start spending it,
 *    and a login that silently repointed traffic would cost real money on an account the operator
 *    was only registering.
 *
 * A real sqlite `AuthStorage`, because the card renders from an inventory that calls a dozen storage
 * methods and the login writes through the same object the card then re-reads. Only `login` itself
 * is stubbed: it is a browser round trip.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { AuthStorage, type OAuthProvider, SqliteAuthCredentialStore } from "@veyyon/ai";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AccountManagerComponent } from "@veyyon/coding-agent/modes/components/account/account-manager";
import { SelectorController } from "@veyyon/coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { useIsolatedAgentDir } from "../../helpers/isolated-agent-dir";

useIsolatedAgentDir({ globalSettings: true });

const SESSION_ID = "session-add-account-test";
/** Arrow down, as a terminal sends it: the card's own key matcher reads the escape sequence. */
const DOWN = "\x1b[B";
const ENTER = "\r";

let tempDir = "";
let store: SqliteAuthCredentialStore | undefined;
let authStorage: AuthStorage | undefined;

beforeAll(async () => {
	await initTheme();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-add-account-"));
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

/** The slice of the login dialog a cancellation test drives. */
interface FocusableDialog {
	handleInput: (key: string) => void;
}

interface Harness {
	/** Every card the controller mounted, oldest first. The second one is the reopen. */
	readonly cards: AccountManagerComponent[];
	/** The card currently on screen, which is the one a key press goes to. */
	readonly card: () => AccountManagerComponent;
	readonly text: (card?: AccountManagerComponent) => string;
	readonly login: ReturnType<typeof vi.fn>;
	readonly showError: ReturnType<typeof vi.fn>;
	/**
	 * The login dialog the controller focused, so a test can cancel it the way Esc
	 * does. Cancelling has to run the real dialog path: its abort signal is what
	 * tells the controller a decision was made rather than a failure.
	 */
	readonly focused: () => FocusableDialog | undefined;
	/** The controller under test, so a test can reach an entry point the card does not offer. */
	readonly controller: SelectorController;
	/** Every fullscreen overlay the controller mounted, in order, by constructor name. */
	readonly fullscreen: string[];
}

/**
 * Build the controller with one stored anthropic account and `login` answering `outcome`.
 *
 * `outcome` is what the provider does when the browser round trip finishes: `"stores"` writes a
 * second credential the way a real login does, `"fails"` rejects the way an unreachable provider
 * or a refused consent screen does, and `"hangs"` settles only when the dialog aborts.
 *
 * `entry` selects which surface starts the login. `"card"` opens the account manager first, the
 * way `/account` does. `"none"` leaves the controller unmounted so a test can call another entry
 * point directly — the failure contract belongs to all of them, not to the card.
 */
async function openCard(outcome: "stores" | "fails" | "hangs", entry: "card" | "none" = "card"): Promise<Harness> {
	const storage = authStorage;
	if (!storage) throw new Error("no auth storage");
	vi.restoreAllMocks();
	// Health probing is an HTTP call per credential and has nothing to do with this contract.
	vi.spyOn(storage, "checkCredentials").mockResolvedValue([]);
	await storage.set("anthropic", [credential("first@example.com", "acct-first")]);

	const login = vi.fn(async (provider: OAuthProvider, options?: { signal?: AbortSignal }) => {
		if (outcome === "fails") throw new Error("provider refused");
		if (outcome === "hangs") {
			// A real browser round trip does not finish on its own. Resolve only when
			// the dialog aborts, which is what Esc does, so the cancellation test
			// exercises the same path a user takes.
			await new Promise<void>(resolve =>
				options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
			);
			throw new Error("login cancelled");
		}
		await storage.set("anthropic", [
			credential("first@example.com", "acct-first"),
			credential("second@example.com", "acct-second"),
		]);
		return { type: "oauth" as const, email: "second@example.com", provider };
	});
	vi.spyOn(storage, "login").mockImplementation(login as unknown as AuthStorage["login"]);

	const cards: AccountManagerComponent[] = [];
	const fullscreen: string[] = [];
	let focused: FocusableDialog | undefined;
	const showError = vi.fn();
	const ctx = {
		editorContainer: { children: [], clear: () => {}, addChild: () => {} },
		editor: {},
		oauthManualInput: { waitForInput: async () => "", clear: () => {} },
		present: vi.fn(),
		ui: {
			setFocus: vi.fn((component: unknown) => {
				if (component && component !== cards[cards.length - 1]) focused = component as FocusableDialog;
			}),
			requestRender: vi.fn(),
			requestComponentRender: vi.fn(),
			showOverlay: vi.fn((component: unknown, options?: { fullscreen?: boolean }) => {
				if (component instanceof AccountManagerComponent) cards.push(component);
				// What hides a written error is a fullscreen overlay that is still up,
				// so this tracks live ones: mounted here, dropped again on `hide()`.
				// The login dialog is fullscreen too and tears itself down in the
				// `finally`, which is why the set has to shrink and not only grow.
				if (!options?.fullscreen) return { hide: vi.fn() };
				const name = (component as object).constructor.name;
				fullscreen.push(name);
				return {
					hide: vi.fn(() => {
						const at = fullscreen.lastIndexOf(name);
						if (at >= 0) fullscreen.splice(at, 1);
					}),
				};
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
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError,
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
	} as unknown as InteractiveModeContext;

	const controller = new SelectorController(ctx);
	if (entry === "card") {
		await controller.showAccountManager("anthropic");
		if (cards.length !== 1) throw new Error(`expected one mounted card, got ${cards.length}`);
	}
	return {
		cards,
		card: () => cards[cards.length - 1]!,
		text: (card = cards[cards.length - 1]!) =>
			card
				.render(200)
				.map(line => stripVTControlCharacters(line))
				.join("\n"),
		login,
		showError,
		focused: () => focused,
		controller,
		fullscreen,
	};
}

/**
 * Wait for `predicate`, bounded.
 *
 * The add-account callback is fire-and-forget by construction (a key press cannot await a browser
 * login), so the reopen lands a few microtasks later. Bounded rather than open-ended so a wiring
 * that never reopens fails as a named timeout instead of hanging the suite.
 */
async function until(predicate: () => boolean, what: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (predicate()) return;
		const tick = Promise.withResolvers<void>();
		setTimeout(tick.resolve, 1);
		await tick.promise;
	}
	throw new Error(`timed out waiting for ${what}`);
}

describe("adding an account from the card", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	/** The card knows the provider. Asking again would be a step the user already took. */
	it("starts a login for the provider the card is showing", async () => {
		const harness = await openCard("stores");

		harness.card().handleInput("a");
		await until(() => harness.login.mock.calls.length > 0, "the login to start");

		expect(harness.login.mock.calls[0]?.[0]).toBe("anthropic");
	});

	/**
	 * The contract the old wiring could not meet: after the login the card is BACK, on the same
	 * provider, and the account that was just stored is in the list. Before the fix this reached the
	 * composer with one mounted card and the new credential shown nowhere.
	 */
	it("comes back to the card with the new account listed", async () => {
		const harness = await openCard("stores");

		harness.card().handleInput("a");
		await until(() => harness.cards.length > 1, "the card to reopen");

		const reopened = harness.text();
		expect(reopened).toContain("second@example.com");
		expect(reopened).toContain("first@example.com");
	});

	/**
	 * The second call site. `enter` on the `+ add another …` row is a separate branch from the `a`
	 * key, and a fix applied to one of them leaves the other exiting to the composer.
	 */
	it("comes back when the add row is activated rather than the key pressed", async () => {
		const harness = await openCard("stores");

		// One stored account, so a single step off it lands on the add entry.
		harness.card().handleInput(DOWN);
		harness.card().handleInput(ENTER);
		await until(() => harness.cards.length > 1, "the card to reopen from the add row");

		expect(harness.login.mock.calls[0]?.[0]).toBe("anthropic");
		expect(harness.text()).toContain("second@example.com");
	});

	/**
	 * A login that FAILED leaves the operator looking at the reason.
	 *
	 * This suite used to assert the opposite, on the reasoning that dropping to the composer strands
	 * the operator with an error and no way back. That reasoning missed what the card is: a
	 * FULLSCREEN overlay. Reopening it painted straight over the error that had just been written to
	 * the transcript, so a rejected API key showed as "Validating…", then the same card, no new
	 * account, and nothing said why. The old test passed throughout, because it asserted that a
	 * `showError` SPY had been called rather than that a human could read anything.
	 *
	 * `showLogin` already stayed put on failure, so this is also the two surfaces agreeing.
	 */
	it("stays on the error after a login that failed, instead of covering it with the card", async () => {
		const harness = await openCard("fails");

		harness.card().handleInput("a");
		await until(() => harness.showError.mock.calls.length > 0, "the failure to be reported");
		// Settle every microtask the reopen would have used, so this asserts the
		// card never comes back rather than merely that it had not yet.
		for (let tick = 0; tick < 50; tick++) await Promise.resolve();

		expect(harness.cards.length).toBe(1);
		// Nothing fullscreen is standing on top of the error either. Stated over
		// every fullscreen overlay rather than the card, because any of them hides
		// it just as completely; the login dialog's own overlay is torn down in the
		// `finally` before the outcome is returned.
		expect(harness.fullscreen).toEqual([]);
		// The message itself, not that a spy fired: the point of the fix is that a
		// person can read the reason.
		expect(String(harness.showError.mock.calls[0]?.[0])).toContain("provider refused");
	});

	/**
	 * The same contract from `/login <provider>`, which reaches `#handleOAuthLogin` through its own
	 * call site with its own guard. A fix applied at one call site and not the other leaves the
	 * operator staring at a fresh account card on one route and the reason on the other, which is
	 * the disagreement between two surfaces reporting the same state that review.md rejects.
	 *
	 * NOT CAUGHT: a fourth entry point added later. The three that exist today are the account
	 * card, this, and the model hub row; the first two are reachable from this harness and the
	 * third shares their guard. A new one is only covered when it is added here.
	 */
	it("stays on the error when the login came from /login rather than the card", async () => {
		const harness = await openCard("fails", "none");

		await harness.controller.showLogin("anthropic");
		for (let tick = 0; tick < 50; tick++) await Promise.resolve();

		expect(String(harness.showError.mock.calls[0]?.[0])).toContain("provider refused");
		expect(harness.cards.length).toBe(0);
		expect(harness.fullscreen).toEqual([]);
	});

	/**
	 * Cancelling is a decision, not a failure, and it still unwinds one level to the card.
	 *
	 * Driven through the real dialog: Esc reaches `LoginDialogComponent`, which aborts the signal the
	 * provider flow is holding. That abort is the only thing distinguishing this from the case above,
	 * so a fix that keyed the reopen off "did it store" rather than "did it fail" would strand the
	 * operator in the composer every time they changed their mind, and this is what catches it.
	 */
	it("comes back to the card when the login is cancelled rather than failed", async () => {
		const harness = await openCard("hangs");

		harness.card().handleInput("a");
		await until(() => harness.focused() !== undefined, "the login dialog to take focus");
		harness.focused()?.handleInput("\x1b");
		await until(() => harness.cards.length > 1, "the card to reopen after cancelling");

		expect(harness.showError).not.toHaveBeenCalled();
		expect(harness.text()).toContain("first@example.com");
	});

	/**
	 * Registering an account is not the same as spending it. With load balancing off the selection
	 * decides which credential drains, so a login that quietly repointed it would move the bill to
	 * an account the operator had not chosen — the exact silent-depletion failure the default is
	 * there to prevent.
	 */
	it("does not move the session's traffic to the account it just stored", async () => {
		const harness = await openCard("stores");
		const storage = authStorage;
		if (!storage) throw new Error("no auth storage");
		const before = storage.listStoredCredentials("anthropic")[0]!.id;
		storage.selectProviderCredential("anthropic", before, { sessionId: SESSION_ID });

		harness.card().handleInput("a");
		await until(() => harness.cards.length > 1, "the card to reopen");

		expect(storage.sessionCredentialRouting("anthropic", SESSION_ID)?.selectedCredentialId).toBe(before);
	});
});
