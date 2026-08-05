/**
 * `/account` end to end: the verbs a user types, driven through the real command registry.
 *
 * WHY THIS SUITE EXISTS. Two of these behaviors are silent-failure shaped. `/account name` with no
 * text must CLEAR the name rather than store an empty one — an empty name is worse than none,
 * because the label ladder would render nothing and the account becomes unidentifiable. And a
 * refused write must be reported as a refusal: `setAccountName` returns false when the store keeps
 * no names, and telling the user their account is now called "home" when nothing was written is the
 * kind of lie a user only discovers days later.
 *
 * Everything runs against a real `AuthStorage` over an in-memory sqlite store, and through
 * `executeBuiltinSlashCommand`, so the parse, the verb routing and the storage write are the ones
 * that ship. Only the interactive context is a stand-in.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai";
import * as oauthUtils from "@veyyon/ai/registry/oauth";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { executeAcpBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";

const PROVIDER = "unit-accounts";
const OTHER_PROVIDER = "unit-idle";
const SESSION_ID = "session-account-verbs";
const NOW_MS = 1_760_000_000_000;
const HOUR_MS = 60 * 60_000;

interface Harness {
	authStorage: AuthStorage;
	runtime: { ctx: InteractiveModeContext; handleBackgroundCommand: () => void };
	status: string[];
	warnings: string[];
	managerOpenedWith: Array<string | undefined>;
	editorText: string[];
}

describe("/account verbs", () => {
	let store: SqliteAuthCredentialStore | null = null;
	let harness: Harness | null = null;
	let workId = 0;
	let personalId = 0;

	function buildHarness(authStorage: AuthStorage, providerOfCurrentModel?: string): Harness {
		const status: string[] = [];
		const warnings: string[] = [];
		const managerOpenedWith: Array<string | undefined> = [];
		const editorText: string[] = [];
		const session = {
			sessionId: SESSION_ID,
			model: providerOfCurrentModel ? { provider: providerOfCurrentModel, id: "unit-model-1" } : undefined,
			modelRegistry: { authStorage, getAvailable: () => [] },
			settings: { get: (path: string) => (path === "providers.webSearch" ? "auto" : undefined) },
			fetchUsageReports: async () => null,
		} as unknown as AgentSession;
		const ctx = {
			session,
			editor: { setText: (text: string) => editorText.push(text) },
			showStatus: (text: string) => status.push(text),
			showWarning: (text: string) => warnings.push(text),
			showAccountManager: async (provider?: string) => {
				managerOpenedWith.push(provider);
			},
		} as unknown as InteractiveModeContext;
		return {
			authStorage,
			runtime: { ctx, handleBackgroundCommand: () => {} },
			status,
			warnings,
			managerOpenedWith,
			editorText,
		};
	}

	beforeEach(async () => {
		setSystemTime(new Date(NOW_MS));
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const authStorage = new AuthStorage(store);
		await authStorage.reload();
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});
		await authStorage.set(PROVIDER, [
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
		await authStorage.set(OTHER_PROVIDER, [
			{
				type: "oauth",
				access: "access-idle",
				refresh: "refresh-idle",
				expires: NOW_MS + 12 * HOUR_MS,
				accountId: "account-idle",
				email: "idle@example.com",
			},
		]);
		const rows = authStorage.listStoredCredentials(PROVIDER);
		workId = rows[0]?.id ?? 0;
		personalId = rows[1]?.id ?? 0;
		authStorage.pinSessionCredential(PROVIDER, SESSION_ID, workId);
		harness = buildHarness(authStorage, PROVIDER);
	});

	afterEach(() => {
		setSystemTime();
		vi.restoreAllMocks();
		store?.close();
		store = null;
		harness = null;
	});

	function current(): Harness {
		if (!harness) throw new Error("test setup failed");
		return harness;
	}

	/**
	 * A bare `/account` renders the inline status block. This is the default because it is the
	 * question the command answers; opening a modal for it would make the answer unavailable to any
	 * client without a terminal.
	 */
	test("a bare /account prints the status block for the routed provider", async () => {
		const handled = await executeBuiltinSlashCommand("/account", current().runtime);

		expect(handled).toBe(true);
		const printed = current().status.join("\n");
		expect(printed.startsWith("Accounts in use by this session")).toBe(true);
		expect(printed).toContain("Unit Accounts");
		expect(printed).toContain("1 of 2 providers in use · /providers to manage accounts");
		expect(current().managerOpenedWith).toEqual([]);
	});

	/**
	 * A provider holding accounts the session never routed to is absent from the block. Asserted
	 * here as well as at the renderer because the wiring is what decides it: passing the whole
	 * inventory to a "print everything" renderer would restore the old provider list.
	 */
	test("a provider the session never routed to is absent from the block", async () => {
		await executeBuiltinSlashCommand("/account status", current().runtime);

		expect(current().status.join("\n")).not.toContain("Unit Idle");
	});

	/**
	 * Naming writes the name for the account THIS session is spending, and the report names both
	 * labels. Reading it back through `getAccountName` is what proves the write landed on the pinned
	 * credential rather than on the provider's first row.
	 */
	test("/account name stores the name for the account in use", async () => {
		await executeBuiltinSlashCommand("/account name home", current().runtime);

		expect(current().authStorage.getAccountName(PROVIDER, workId)).toBe("home");
		expect(current().authStorage.getAccountName(PROVIDER, personalId)).toBeUndefined();
		expect(current().status).toEqual(["Unit Accounts account renamed: work@example.com → home"]);
	});

	/**
	 * THE DEFECT THIS LOCKS OUT: `/account name` with no text storing an empty string. An empty name
	 * wins the label ladder and renders as nothing, so the row loses its identity entirely. Empty
	 * text CLEARS, and the report says the account is back to its own identity.
	 */
	test("/account name with no text clears the name instead of storing an empty one", async () => {
		await executeBuiltinSlashCommand("/account name home", current().runtime);
		current().status.length = 0;

		await executeBuiltinSlashCommand("/account name", current().runtime);

		expect(current().authStorage.getAccountName(PROVIDER, workId)).toBeUndefined();
		expect(current().status).toEqual(["Unit Accounts account name cleared: home → work@example.com"]);
	});

	/**
	 * A store that keeps no names (the remote broker) makes `setAccountName` return false, and the
	 * command must say WHY rather than report a save. The refusal is spied at the storage seam
	 * because it is a property of the store, not of the session: what is asserted here is the
	 * command's reaction to it.
	 */
	test("/account name reports a refused write instead of claiming a save", async () => {
		vi.spyOn(current().authStorage, "setAccountName").mockReturnValue(false);

		await executeBuiltinSlashCommand("/account name home", current().runtime);

		expect(current().status).toEqual([]);
		expect(current().warnings).toEqual([
			"Could not name work@example.com: the credential is unknown to the store, or this store keeps no account names (remote broker).",
		]);
		expect(current().authStorage.getAccountName(PROVIDER, workId)).toBeUndefined();
	});

	/**
	 * `/account switch <provider>` focuses the manager on that provider, and an unknown provider is
	 * a loud warning that names the ids that do exist. Opening the manager anyway would look like
	 * the switch happened.
	 */
	test("/account switch focuses a known provider and refuses an unknown one", async () => {
		await executeBuiltinSlashCommand(`/account switch ${PROVIDER}`, current().runtime);

		expect(current().managerOpenedWith).toEqual([PROVIDER]);

		await executeBuiltinSlashCommand("/account switch nope-inc", current().runtime);

		expect(current().managerOpenedWith).toEqual([PROVIDER]);
		expect(current().warnings).toEqual([
			`No accounts stored for "nope-inc". Providers with accounts: ${PROVIDER}, ${OTHER_PROVIDER}.`,
		]);
	});

	/** `/account manager` and a bare `/account switch` both open the manager unfocused. */
	test("/account manager opens the manager with no provider focus", async () => {
		await executeBuiltinSlashCommand("/account manager", current().runtime);
		await executeBuiltinSlashCommand("/account switch", current().runtime);

		expect(current().managerOpenedWith).toEqual([undefined, undefined]);
	});

	/**
	 * An unknown verb is refused with the real verb list, built from the declaration. A silent
	 * fallback to the status block would make a typo look like it worked.
	 */
	test("an unknown verb is refused and lists the real verbs", async () => {
		await executeBuiltinSlashCommand("/account frobnicate", current().runtime);

		expect(current().warnings).toEqual([
			'Unknown /account subcommand "frobnicate". Use status, manager, switch, name, refresh, usage, logout, add.',
		]);
		expect(current().status).toEqual([]);
	});

	/**
	 * With no model resolved there is no provider whose account could be named, and the command says
	 * so instead of naming an arbitrary provider's first credential.
	 */
	test("/account name refuses when no model is active", async () => {
		const noModel = buildHarness(current().authStorage, undefined);

		await executeBuiltinSlashCommand("/account name home", noModel.runtime);

		expect(noModel.warnings).toEqual(["No model is active, so no account is routed. Pick one with /model first."]);
		expect(noModel.status).toEqual([]);
		expect(current().authStorage.getAccountName(PROVIDER, workId)).toBeUndefined();
	});

	/**
	 * A provider whose accounts the session has not routed to yet cannot be named blind: the command
	 * points at the manager rather than picking a row on the user's behalf.
	 */
	test("/account name refuses when the provider has routed nothing yet", async () => {
		const idleModel = buildHarness(current().authStorage, OTHER_PROVIDER);

		await executeBuiltinSlashCommand("/account name home", idleModel.runtime);

		expect(idleModel.warnings).toEqual(["No Unit Idle account is serving this session yet. /providers to pick one."]);
		expect(idleModel.status).toEqual([]);
		expect(current().authStorage.getAccountName(OTHER_PROVIDER, 1)).toBeUndefined();
	});

	/**
	 * `/account refresh` reports a BEFORE → AFTER pair per routed account, with the upstream reason
	 * on a failure. The reason is the actionable half: `invalid_grant` means log in again, while a
	 * rate limit means wait, and a bare "failed" cannot tell a user which.
	 */
	test("/account refresh reports the health delta with the upstream reason", async () => {
		vi.spyOn(current().authStorage, "checkCredentials").mockResolvedValue([
			{
				id: workId,
				provider: PROVIDER,
				type: "oauth",
				ok: false,
				reason: "invalid_grant: refresh token revoked",
			},
		]);

		await executeBuiltinSlashCommand("/account refresh", current().runtime);

		expect(current().status).toEqual([
			[
				"Re-probed the accounts this session is using",
				"  Unit Accounts work@example.com: not probed → failed (invalid_grant: refresh token revoked)",
				"  1 of 1 failed the probe.",
			].join("\n"),
		]);
	});

	/**
	 * Only the accounts this session can spend are named. Probing answers for every stored
	 * credential, and printing all of them would bury the one line that matters in an inline report.
	 */
	test("/account refresh names only the routed accounts", async () => {
		vi.spyOn(current().authStorage, "checkCredentials").mockResolvedValue([
			{ id: workId, provider: PROVIDER, type: "oauth", ok: true },
			{ id: personalId, provider: PROVIDER, type: "oauth", ok: false, reason: "rate limited" },
		]);

		await executeBuiltinSlashCommand("/account refresh", current().runtime);

		const printed = current().status.join("\n");
		expect(printed).toContain("  Unit Accounts work@example.com: not probed → ok");
		expect(printed).not.toContain("personal@example.com");
		expect(printed).toContain("  Every account in use answered.");
	});

	/**
	 * A text client gets the SAME block. `/account` is declared `textMode`, and the whole point of
	 * the inline form is that a client with no terminal can still answer "which account am I on" —
	 * a TUI-only report would leave ACP and RPC users with no answer at all.
	 */
	test("text mode prints the same status block through runtime.output", async () => {
		const said: string[] = [];
		const runtime = {
			session: current().runtime.ctx.session,
			output: (text: string) => {
				said.push(text);
			},
		} as unknown as SlashCommandRuntime;

		const result = await executeAcpBuiltinSlashCommand("/account", runtime);

		expect(result).toEqual({ consumed: true });
		expect(said.join("\n").startsWith("Accounts in use by this session")).toBe(true);
		expect(said.join("\n")).toContain("1 of 2 providers in use · /providers to manage accounts");
	});

	/**
	 * A verb that opens a view cannot run without a terminal, and it says so plus what CAN be done
	 * from here. Silently doing nothing is the failure mode this replaces: the command would look
	 * accepted and no view would ever appear.
	 */
	test("text mode refuses the view verbs and names the ones it can run", async () => {
		const said: string[] = [];
		const runtime = {
			session: current().runtime.ctx.session,
			output: (text: string) => {
				said.push(text);
			},
		} as unknown as SlashCommandRuntime;

		await executeAcpBuiltinSlashCommand("/account manager", runtime);

		expect(said).toEqual([
			"/account manager opens a view, which needs the interactive TUI. From here: /account status, /account name <text>, /account refresh, /account usage.",
		]);
		expect(current().managerOpenedWith).toEqual([]);
	});
});
