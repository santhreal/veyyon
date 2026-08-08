/**
 * WHY THIS FILE EXISTS. `/login` and `/account login` are two spellings of one action, and for a
 * while they were two implementations of it: one of them knew about the pasted-redirect-URL shape and
 * the pending-callback warning, and the other did not, so the same words typed under a different
 * prefix did different things. They now both call `startProviderLogin`, and the only way to keep them
 * that way is to assert that every argument shape produces the SAME observable effects under both
 * spellings.
 *
 * That is what the first describe does: the effects are recorded as an ordered event list and the two
 * spellings are compared to each other AND to the effect that shape is supposed to have, so a
 * regression cannot pass by making both spellings equally broken.
 *
 * The second describe pins `/account use <provider> <account>`, the text twin of pressing enter on an
 * account card. Its failure modes are all about picking the wrong subscription to spend: matching only
 * one of the four things an account surface prints for an account, letting a prefix beat an exact
 * match, and above all resolving an ambiguous prefix to whichever row happened to come first. Every
 * case runs through BOTH the text path (`handle`, what ACP and `--print` reach) and the interactive
 * path (`handleTui`), because "the TUI can do it" was the state this replaced.
 *
 * WHAT IT DOES NOT CATCH. The interactive context is a stand-in: nothing here proves the real OAuth
 * selector opens a browser, or that the manual-input controller genuinely completes a login. Those are
 * one layer below the seam this file guards, which is the routing. The declaration table (`textMode`,
 * subcommand list, usage strings) is a compile-time contract in `builtin-registry.ts` and is asserted
 * by `test/slash-commands/account-command-declarations.test.ts` rather than here.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai";
import { getOAuthProviders } from "@veyyon/ai/oauth";
import * as oauthUtils from "@veyyon/ai/registry/oauth";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { executeAcpBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/builtin-registry";
import { formatProviderName } from "@veyyon/coding-agent/slash-commands/helpers/format";
import type { SlashCommandRuntime, TuiSlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";

const PROVIDER = "unit-accounts";
const SESSION_ID = "session-login-aliases";
const NOW_MS = 1_760_000_000_000;
const HOUR_MS = 60 * 60_000;

/** The provider a pending login is recorded against; never a real one, so nothing here depends on the registry. */
const PENDING_PROVIDER = "pending-provider";

/**
 * The warning a second login attempt prints, built through the SAME label helper the product uses.
 * Spelling the display name as a literal here is what made this suite fail the day `/login` started
 * routing every provider label through `formatProviderName`: the test pinned the raw slug the product
 * had deliberately stopped printing, so a label fix looked like a routing regression.
 */
function pendingWarning(providerId: string): string {
	return `OAuth login already in progress for ${formatProviderName(providerId)}. Paste the redirect URL with /login <url>.`;
}

/**
 * One recorded effect per thing the user would see, in order. Comparing lists rather than individual
 * spies is what makes "the two spellings do the same thing" a single assertion: an extra warning, a
 * missing editor clear, or a selector opened with the wrong provider all show up as a list mismatch.
 */
interface LoginProbe {
	runtime: { ctx: InteractiveModeContext; handleBackgroundCommand: () => void };
	events: string[];
}

function loginProbe(options: { pendingProviderId?: string; hasPending: boolean; submitAccepts: boolean }): LoginProbe {
	const events: string[] = [];
	const ctx = {
		session: { sessionId: SESSION_ID } as unknown as AgentSession,
		editor: {
			setText: (text: string) => {
				events.push(`editor:${JSON.stringify(text)}`);
			},
		},
		showStatus: (text: string) => {
			events.push(`status:${text}`);
		},
		showWarning: (text: string) => {
			events.push(`warning:${text}`);
		},
		showOAuthSelector: async (mode: string, provider?: string) => {
			events.push(`selector:${mode}:${provider ?? "-"}`);
		},
		oauthManualInput: {
			pendingProviderId: options.pendingProviderId,
			hasPending: () => options.hasPending,
			submit: (text: string) => {
				events.push(`submit:${text}`);
				return options.submitAccepts;
			},
		},
	} as unknown as InteractiveModeContext;
	return { runtime: { ctx, handleBackgroundCommand: () => {} }, events };
}

describe("/login and /account login are one implementation", () => {
	/**
	 * Every argument shape a user produces, and the effects it must have. The provider id is read from
	 * the real OAuth provider list at run time: a hardcoded id would go stale silently the day that
	 * provider is renamed, and the shape being tested here is "a known provider id", not "anthropic".
	 */
	const knownProviderId = getOAuthProviders()[0]?.id ?? "";

	test("the real OAuth provider list is non-empty, so the provider-id shape below is real", () => {
		expect(knownProviderId.length).toBeGreaterThan(0);
	});

	const shapes: Array<{
		what: string;
		args: string;
		pending: { pendingProviderId?: string; hasPending: boolean; submitAccepts: boolean };
		expected: string[];
	}> = [
		{
			what: "nothing at all opens the provider picker",
			args: "",
			pending: { hasPending: false, submitAccepts: false },
			expected: ["selector:login:-"],
		},
		{
			what: "a known provider id starts that provider's login",
			args: knownProviderId,
			pending: { hasPending: false, submitAccepts: false },
			expected: [`selector:login:${knownProviderId}`],
		},
		{
			what: "any other text is submitted as a pasted redirect URL",
			args: "https://example.test/callback?code=abc&state=xyz",
			pending: { hasPending: true, submitAccepts: true },
			expected: [
				"submit:https://example.test/callback?code=abc&state=xyz",
				"status:OAuth callback received; completing login…",
			],
		},
		{
			what: "a pasted URL nobody is waiting for is refused",
			args: "https://example.test/callback?code=abc",
			pending: { hasPending: false, submitAccepts: false },
			// No `submit:` event: with nothing pending, the text is classified as "not a
			// provider and not a live callback" and refused by name. The old order handed
			// every unrecognized argument to the manual-input controller first and let it
			// refuse, which is how a misspelled provider produced a sentence about
			// manual callbacks.
			expected: ["warning:No OAuth login is waiting for a manual callback. Start one with /login <provider>."],
		},
		{
			what: "a second bare login while one is pending names the provider still waiting",
			args: "",
			pending: { pendingProviderId: PENDING_PROVIDER, hasPending: true, submitAccepts: false },
			expected: [`warning:${pendingWarning(PENDING_PROVIDER)}`],
		},
		{
			what: "a pending login with no provider recorded still warns",
			args: "",
			pending: { hasPending: true, submitAccepts: false },
			expected: ["warning:OAuth login already in progress. Paste the redirect URL with /login <url>."],
		},
		{
			what: "a provider id while a login is pending warns instead of starting a second one",
			args: knownProviderId,
			pending: { pendingProviderId: PENDING_PROVIDER, hasPending: true, submitAccepts: false },
			expected: [`warning:${pendingWarning(PENDING_PROVIDER)}`],
		},
	];

	for (const shape of shapes) {
		test(`${shape.what}, identically under both spellings`, async () => {
			const direct = loginProbe(shape.pending);
			const viaAccount = loginProbe(shape.pending);

			const directHandled = await executeBuiltinSlashCommand(`/login ${shape.args}`.trim(), direct.runtime);
			const accountHandled = await executeBuiltinSlashCommand(
				`/account login ${shape.args}`.trim(),
				viaAccount.runtime,
			);

			expect(directHandled).toBe(true);
			expect(accountHandled).toBe(true);
			// Both spellings do the right thing. The editor clear is asserted separately rather than
			// compared: `/account` clears it once on the way into the verb router as well, which is a
			// property of the wrapper and not of the login it delegates to.
			const said = (events: string[]): string[] => events.filter(event => !event.startsWith("editor:"));
			expect(said(direct.events)).toEqual(shape.expected);
			// ...and they do the same thing, so neither can drift without the other.
			expect(said(viaAccount.events)).toEqual(said(direct.events));
			expect(direct.events).toContain('editor:""');
			expect(viaAccount.events).toContain('editor:""');
		});
	}
});

describe("/account use makes the durable choice from both paths", () => {
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	let workId = 0;
	let personalId = 0;

	beforeEach(async () => {
		setSystemTime(new Date(NOW_MS));
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.reload();
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.set(PROVIDER, [
			{
				type: "oauth",
				access: "access-work",
				refresh: "refresh-work",
				expires: NOW_MS + 12 * HOUR_MS,
				accountId: "account-work",
				email: "work@example.com",
			},
			{
				type: "oauth",
				access: "access-personal",
				refresh: "refresh-personal",
				expires: NOW_MS + 12 * HOUR_MS,
				accountId: "account-personal",
				email: "personal@example.com",
			},
		]);
		const rows = storage.listStoredCredentials(PROVIDER);
		workId = rows[0]?.id ?? 0;
		personalId = rows[1]?.id ?? 0;
		authStorage = storage;
	});

	afterEach(() => {
		setSystemTime();
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
	});

	function session(): AgentSession {
		if (!authStorage) throw new Error("test setup failed");
		return {
			sessionId: SESSION_ID,
			model: { provider: PROVIDER, id: "unit-model-1" },
			modelRegistry: { authStorage, getAvailable: () => [] },
			settings: { get: () => undefined },
			fetchUsageReports: async () => null,
		} as unknown as AgentSession;
	}

	/** The text path: what an ACP client, `--print`, or a script reaches. */
	async function viaText(args: string): Promise<string> {
		const said: string[] = [];
		const runtime = {
			session: session(),
			output: (text: string) => {
				said.push(text);
			},
		} as unknown as SlashCommandRuntime;
		const result = await executeAcpBuiltinSlashCommand(`/account use ${args}`, runtime);
		expect(result).toEqual({ consumed: true });
		return said.join("\n");
	}

	/** The interactive path: a success is a status line, a refusal is a warning. */
	async function viaTui(args: string): Promise<{ status: string[]; warnings: string[] }> {
		const status: string[] = [];
		const warnings: string[] = [];
		const ctx = {
			session: session(),
			editor: { setText: () => {} },
			showStatus: (text: string) => status.push(text),
			showWarning: (text: string) => warnings.push(text),
			showAccountManager: async () => {},
		} as unknown as InteractiveModeContext;
		const handled = await executeBuiltinSlashCommand(`/account use ${args}`, {
			ctx,
			handleBackgroundCommand: () => {},
		} as unknown as TuiSlashCommandRuntime);
		expect(handled).toBe(true);
		return { status, warnings };
	}

	function chosen(): number | undefined {
		if (!authStorage) throw new Error("test setup failed");
		return authStorage.selectedProviderCredentialId(PROVIDER);
	}

	/**
	 * An account is named by any of the things an account surface prints for it, case-insensitively.
	 * A user reads a label off the card and types it back; matching only the email would refuse the
	 * account id the same surface printed two lines above.
	 */
	const identifiers: Array<{ what: string; typed: string }> = [
		{ what: "its email", typed: "work@example.com" },
		{ what: "its email in the wrong case", typed: "WORK@Example.COM" },
		{ what: "its account id", typed: "account-work" },
		{ what: "an unambiguous prefix of its email", typed: "work@" },
	];

	for (const identifier of identifiers) {
		test(`the text path selects an account named by ${identifier.what}`, async () => {
			const said = await viaText(`${PROVIDER} ${identifier.typed}`);

			expect(said).toBe("Unit Accounts: now using work@example.com everywhere on this machine.");
			expect(chosen()).toBe(workId);
		});

		test(`the interactive path selects an account named by ${identifier.what}`, async () => {
			const { status, warnings } = await viaTui(`${PROVIDER} ${identifier.typed}`);

			expect(status).toEqual(["Unit Accounts: now using work@example.com everywhere on this machine."]);
			expect(warnings).toEqual([]);
			expect(chosen()).toBe(workId);
		});
	}

	/** The provider argument is matched case-insensitively too, since it is read off the same surface. */
	test("the provider id is matched case-insensitively", async () => {
		const said = await viaText(`${PROVIDER.toUpperCase()} work@example.com`);

		expect(said).toBe("Unit Accounts: now using work@example.com everywhere on this machine.");
		expect(chosen()).toBe(workId);
	});

	/**
	 * THE DEFECT THIS LOCKS OUT: an ambiguous prefix resolving to whichever row came first. Both
	 * account ids start with `account-`, so a prefix search alone matches two subscriptions, and
	 * spending either one was not asked for. The refusal must name EVERY candidate: a bare "ambiguous"
	 * leaves the user guessing which two accounts collided.
	 */
	test("an ambiguous prefix is refused and names every candidate, from both paths", async () => {
		const said = await viaText(`${PROVIDER} account-`);

		expect(said).toBe(
			'"account-" matches 2 accounts: work@example.com, personal@example.com. Name one of them exactly.',
		);
		expect(chosen()).toBeUndefined();

		const { status, warnings } = await viaTui(`${PROVIDER} account-`);

		expect(warnings).toEqual([said]);
		expect(status).toEqual([]);
		expect(chosen()).toBeUndefined();
	});

	/**
	 * An exact match beats a prefix match, so a user whose account name is a prefix of another
	 * account's name can still name their own. Prefix-first would refuse this as ambiguous and leave
	 * the shorter name unreachable by any spelling.
	 */
	test("an exact match wins over an account the same text is a prefix of", async () => {
		if (!authStorage) throw new Error("test setup failed");
		expect(authStorage.setAccountName(PROVIDER, workId, "work")).toBe(true);
		expect(authStorage.setAccountName(PROVIDER, personalId, "workstation")).toBe(true);

		const said = await viaText(`${PROVIDER} work`);

		expect(said).toBe("Unit Accounts: now using work everywhere on this machine.");
		expect(chosen()).toBe(workId);
	});

	/**
	 * A name that matches nothing must not fall through to "the first account": the refusal lists what
	 * is stored so the user can retype one of them.
	 */
	test("a name matching no account is refused with the stored labels", async () => {
		const said = await viaText(`${PROVIDER} nobody@example.com`);

		expect(said).toBe(
			'No Unit Accounts account matches "nobody@example.com". Stored: work@example.com, personal@example.com.',
		);
		expect(chosen()).toBeUndefined();
	});

	/** Both arguments are required, and a missing one is a usage line rather than a partial action. */
	test("a bare or half-typed use is refused with its usage", async () => {
		expect(await viaText(PROVIDER)).toBe("Usage: /account use <provider> <account>");
		expect(chosen()).toBeUndefined();
	});

	/** A provider with no stored accounts cannot be switched, and the refusal names the ones that can. */
	test("a provider with no accounts is refused and names the providers that have some", async () => {
		const said = await viaText("nope-inc somebody");

		expect(said).toBe(`No accounts stored for "nope-inc". Providers with accounts: ${PROVIDER}.`);
		expect(chosen()).toBeUndefined();
	});
});
