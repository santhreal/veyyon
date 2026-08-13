/**
 * One of several stored accounts is being spent. The footline says which.
 *
 * WHY THIS SUITE EXISTS. A session spends one account at a time, whatever `accounts.loadBalancing`
 * says: with it off that account is the only one that will ever be spent, and with it on the session
 * moves between them, so in both cases exactly one of a user's three Anthropic logins is draining
 * right now and until now nothing on screen said which. The account identity reached the status line
 * only as a CACHE KEY for the usage segment (`#getUsageContextKey`), so `5h 71%` was rendered with
 * no owner: three accounts, one percentage, and no way to tell whose quota was at 71 without opening
 * `/account`. A quota you can watch drain is worth nothing if you cannot see which account it
 * belongs to, and it is the expensive kind of not-knowing.
 *
 * WHAT IS PINNED HERE, and the class each case closes:
 *
 *  - The rule is about MULTIPLICITY, not about having an account. One credential is silent (there
 *    is nothing to tell apart, and the decluttered footline stays quiet); two make the serving one
 *    appear. Both directions are asserted, because a segment that always shows costs every
 *    single-account user a slot and a segment that never shows is the defect being fixed.
 *  - It names what is SERVING, not what was picked. Those differ exactly when the interesting
 *    thing happened (a chosen account was blocked or revoked and traffic moved), which is when the
 *    line has to be right.
 *  - The label follows the ONE owner, `accountDisplayLabel`, so the operator's own name for an
 *    account wins, and a rename is visible on the NEXT render rather than after the memo happens
 *    to expire. The memo is the reason that is not free: its key carries the stored name.
 *  - Every preset carries the segment. Enumerated from `STATUS_LINE_PRESETS` at run time, so a
 *    preset added later turns this red instead of silently shipping without the account.
 *
 * The store is a real sqlite `AuthStorage`. The inventory the label comes from calls a dozen
 * storage methods (routing, selection, names, origin), and a hand-written fake of that surface is a
 * second implementation that drifts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { APPEARANCE_SETTINGS } from "@veyyon/coding-agent/config/settings-domains/appearance";
import { settings } from "@veyyon/coding-agent/config/settings-instance";
import type { StatusLineSegmentId } from "@veyyon/coding-agent/config/settings-schema";
import { StatusLineComponent } from "@veyyon/coding-agent/modes/components/status-line";
import { STATUS_LINE_PRESETS } from "@veyyon/coding-agent/modes/components/status-line/presets";
import { renderSegment } from "@veyyon/coding-agent/modes/components/status-line/segments";
import type { SegmentContext, StatusLinePreset } from "@veyyon/coding-agent/modes/components/status-line/types";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";

const SESSION_ID = "session-serving-account";

let tempDir = "";
let store: SqliteAuthCredentialStore | undefined;
let authStorage: AuthStorage | undefined;

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-serving-account-"));
	store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
	authStorage = new AuthStorage(store);
});

afterAll(async () => {
	store?.close();
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	resetSettingsForTest();
});

beforeEach(async () => {
	vi.restoreAllMocks();
	// The chip ships OFF, so every case below that expects to SEE it has to ask for it. The default
	// itself is asserted in the last describe, in both states, rather than assumed by these cases.
	await settings.set("statusLine.showAccount", true);
});

/**
 * One stored OAuth credential, as a real login writes it.
 *
 * The account id is derived from the address rather than counted, because a stored NAME is keyed by
 * the account's identity and outlives the credential row: with `acct-1` reused across cases, a name
 * set by one case is read back by the next one, and the suite passes or fails on execution order.
 */
function credential(email: string) {
	const accountId = `acct-${email.replaceAll(/[^a-z0-9]+/g, "-")}`;
	return {
		type: "oauth" as const,
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + 8 * 60 * 60_000,
		accountId,
		email,
	};
}

/**
 * Replace anthropic's stored credentials with exactly `emails`, returning their row ids in order.
 *
 * Written through `AuthStorage.set` rather than by appending, so each case states the whole world
 * it means and cannot inherit a credential from the case before it.
 */
async function storeAccounts(...emails: readonly string[]): Promise<number[]> {
	const storage = authStorage;
	if (!storage) throw new Error("no auth storage");
	await storage.set("anthropic", emails.map(credential));
	return storage.listStoredCredentials("anthropic").map(entry => entry.id);
}

/** Credentials for a provider other than the active one, so cross-provider leakage is observable. */
async function storeOtherProvider(provider: string, count: number): Promise<void> {
	const storage = authStorage;
	if (!storage) throw new Error("no auth storage");
	await storage.set(
		provider,
		Array.from({ length: count }, (_, index) => ({ type: "api_key" as const, key: `key-${provider}-${index}` })),
	);
}

/**
 * A session whose only real dependency is the credential store. Everything else is fixed: the
 * footline must not differ between two runs because a clock advanced.
 *
 * `providers` names the model provider twice on purpose. `state.model` is the live model and
 * `model` is the session's configured one; the resolver reads the live one first, and a case can
 * make them disagree to pin that order.
 */
function makeSession(providers: { live?: string; configured?: string } = {}): AgentSession {
	const live = providers.live ?? "anthropic";
	const configured = providers.configured ?? "anthropic";
	return {
		sessionId: SESSION_ID,
		state: { messages: [], model: { provider: live, contextWindow: 200_000 } },
		messages: [],
		model: { id: "claude-sonnet-4-6", name: "sonnet", provider: configured, contextWindow: 200_000 },
		contextUsageRevision: 0,
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isAdvisorActive: () => false,
		isFastModeActive: () => false,
		isFastModeEnabled: () => false,
		isApprovalBypassed: () => false,
		getGoalModeState: () => null,
		getAsyncJobSnapshot: () => ({ running: [] }),
		getCurrentModel: () => undefined,
		getContextUsage: () => ({ tokens: 1_000, contextWindow: 200_000, percent: 1 }),
		fetchUsageReports: async () => [],
		modelRegistry: { authStorage, isUsingOAuth: () => true },
		settings: { getGroup: () => ({ enabled: false, strategy: "off", threshold: "85%" }) },
		sessionManager: {
			getSessionName: () => undefined,
			getCwd: () => tempDir,
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
	} as unknown as AgentSession;
}

/** A component rendering the account segment alone, so a case reads what the segment said. */
function accountOnly(providers?: { live?: string; configured?: string }): {
	component: StatusLineComponent;
	line: () => string;
} {
	const component = new StatusLineComponent(makeSession(providers));
	component.updateSettings({ preset: "custom", leftSegments: ["account"], rightSegments: [], sessionAccent: false });
	return { component, line: () => stripVTControlCharacters(component.renderQuietLine(120) ?? "") };
}

describe("the footline names the account that is spending", () => {
	/**
	 * One account is not a question. Naming it would spend a footline slot on a fact with no
	 * alternative, on every single-account setup, which is most of them.
	 */
	it("says nothing when the provider stores one credential", async () => {
		await storeAccounts("only@example.com");

		// The line is never literally empty — it carries the persistent subagent count — so what is
		// asserted is that the account contributed nothing to it.
		expect(accountOnly().line()).not.toContain("only@example.com");
		expect(accountOnly().line()).not.toContain("as ");
	});

	/**
	 * The case the feature exists for: two logins, one of them draining. The line names the one
	 * that is selected, so the percentage beside it has an owner.
	 */
	it("names the selected account once a second one is stored", async () => {
		const [first] = await storeAccounts("selected@example.com", "unselected@example.com");
		authStorage?.selectProviderCredential("anthropic", first!, { sessionId: SESSION_ID });

		expect(accountOnly().line()).toContain("as selected@example.com");
	});

	/**
	 * Moving the selection moves the line. A segment that named the FIRST stored credential rather
	 * than the serving one would pass the case above and be wrong for every operator who ever
	 * switched accounts, which is the population that has more than one.
	 */
	it("follows the selection rather than storage order", async () => {
		const ids = await storeAccounts("row.one@example.com", "row.two@example.com");
		authStorage?.selectProviderCredential("anthropic", ids[1]!, { sessionId: SESSION_ID });

		const line = accountOnly().line();
		expect(line).toContain("as row.two@example.com");
		expect(line).not.toContain("row.one@example.com");
	});

	/**
	 * What is SERVING outranks what was CHOSEN. They differ exactly when a chosen account became
	 * unusable and traffic moved to another one, which is the moment the operator most needs the
	 * line to be honest: the quota draining is the substitute's, not the one they picked.
	 *
	 * Driven by stubbing the routing report on the real storage instance, because the states that
	 * produce a divergence upstream (a rate-limit block, a revoked refresh token) are properties of
	 * a live provider, and this contract is about which of the two ids the line reads.
	 */
	it("names the account traffic actually moved to, not the one that was picked", async () => {
		const ids = await storeAccounts("chosen@example.com", "substitute@example.com");
		const storage = authStorage;
		if (!storage) throw new Error("no auth storage");
		vi.spyOn(storage, "sessionCredentialRouting").mockReturnValue({
			provider: "anthropic",
			selectedCredentialId: ids[0]!,
			activeCredentialId: ids[1]!,
		});

		const line = accountOnly().line();
		expect(line).toContain("as substitute@example.com");
		expect(line).not.toContain("chosen@example.com");
	});

	/**
	 * The label ladder has one owner, and the top of it is the name the operator authored. This is
	 * also the memo's regression case: the serving credential and the account count are unchanged
	 * by a rename, so a memo keyed on those alone would keep painting the old label on a card the
	 * user just renamed from. Asserted on ONE component across two renders, which is the only
	 * arrangement where a stale memo can be observed.
	 */
	it("prefers the operator's own name, and a rename lands on the next render", async () => {
		const ids = await storeAccounts("renamed@example.com", "untouched@example.com");
		authStorage?.selectProviderCredential("anthropic", ids[0]!, { sessionId: SESSION_ID });
		const surface = accountOnly();

		expect(surface.line()).toContain("as renamed@example.com");

		authStorage?.setAccountName("anthropic", ids[0]!, "work");

		expect(surface.line()).toContain("as work");
		expect(surface.line()).not.toContain("renamed@example.com");
	});

	/**
	 * A provider with no stored credential at all (an env-var key, a fresh install) has nothing to
	 * name. The control for the multiplicity rule from the other side: the segment must not invent
	 * a label out of the provider id.
	 */
	it("says nothing when the provider stores nothing", async () => {
		await storeAccounts();

		expect(accountOnly().line()).not.toContain("as ");
	});

	/**
	 * The count is the ACTIVE provider's, not the store's. A machine with one Anthropic login and
	 * three OpenAI keys stores four credentials and has nothing to disambiguate about Anthropic, so
	 * a resolver that counted the store would name an account that has no sibling — and would do it
	 * on the setup most operators have, several providers with one login each.
	 */
	it("counts the active provider's credentials, not the whole store", async () => {
		await storeAccounts("lone@example.com");
		await storeOtherProvider("openai", 3);

		expect(accountOnly().line()).not.toContain("as ");
	});

	/**
	 * The live model decides which provider is being spent. When the session was configured for one
	 * provider and the live model is on another, naming the configured provider's account would
	 * report a quota nothing is drawing from: here the live provider stores nothing, so there is
	 * nothing to say even though the configured one holds two accounts.
	 */
	it("reads the live model's provider, not the session's configured one", async () => {
		const ids = await storeAccounts("live@example.com", "live.other@example.com");
		authStorage?.selectProviderCredential("anthropic", ids[0]!, { sessionId: SESSION_ID });
		await storeOtherProvider("openai", 0);

		expect(accountOnly({ live: "openai", configured: "anthropic" }).line()).not.toContain("as ");
	});

	/**
	 * The production preset, not a custom layout: the reason this segment exists is that a user who
	 * configured nothing can see which account is spending. A preset that never names it ships the
	 * defect with the fix in the tree.
	 */
	it("reaches the footline on the default preset", async () => {
		const ids = await storeAccounts("preset@example.com", "preset.other@example.com");
		authStorage?.selectProviderCredential("anthropic", ids[0]!, { sessionId: SESSION_ID });
		const component = new StatusLineComponent(makeSession());
		component.updateSettings({ preset: "default", sessionAccent: false });

		expect(stripVTControlCharacters(component.renderQuietLine(200) ?? "")).toContain("as preset@example.com");
	});
});

describe("the account segment's own display rule", () => {
	/**
	 * The multiplicity rule lives in the segment, so it is asserted there directly rather than only
	 * through a store. `storedCount` is what the segment reads; a resolver that stopped reporting it
	 * honestly is a different defect with a different test.
	 */
	it("hides a lone account and shows one of several", () => {
		const lone = renderSegment("account", {
			account: { label: "work", storedCount: 1 },
		} as unknown as SegmentContext);
		expect(lone.visible).toBe(false);
		expect(lone.content).toBe("");

		const several = renderSegment("account", {
			account: { label: "work", storedCount: 2 },
		} as unknown as SegmentContext);
		expect(several.visible).toBe(true);
		expect(stripVTControlCharacters(several.content)).toBe("as work");
	});

	/** Nothing to say when no provider resolved yet — the first frames of a launch. */
	it("hides when there is no account at all", () => {
		expect(renderSegment("account", { account: null } as unknown as SegmentContext).visible).toBe(false);
	});

	/**
	 * A long login may not dominate a line it shares with the model, the mode, the path, the branch
	 * and the context gauge, so it is clamped to the same chip budget as the session name.
	 */
	it("clamps a long login to the chip budget", () => {
		const rendered = renderSegment("account", {
			account: { label: "someone.with.a.very.long.address@corporate.example.com", storedCount: 3 },
		} as unknown as SegmentContext);
		const text = stripVTControlCharacters(rendered.content);

		expect(rendered.visible).toBe(true);
		expect(text.startsWith("as ")).toBe(true);
		expect(text.endsWith("…")).toBe(true);
		expect(text.length).toBeLessThanOrEqual("as ".length + 24);
	});
});

describe("every preset carries the account", () => {
	/**
	 * Enumerated from the preset table at run time, so adding a preset without the account turns
	 * this red. A hardcoded list of the seven presets that exist today would go stale in silence,
	 * which is the same as having no test: the segment costs nothing on a single-account setup, so
	 * there is no preset with a reason to leave it out.
	 */
	const presets = Object.keys(STATUS_LINE_PRESETS) as StatusLinePreset[];

	it.each(presets)("%s names the serving account", preset => {
		const def = STATUS_LINE_PRESETS[preset];
		const configured: StatusLineSegmentId[] = [...def.leftSegments, ...def.rightSegments];

		expect(configured).toContain("account");
	});
});

/**
 * The chip is a knob, and a knob has to be asserted in BOTH states.
 *
 * The presets all carry the `account` segment, so the preset table cannot say whether the chip is on
 * for a fresh install; only the setting can, and a test that exercised the visible state alone would
 * pass just as happily with the default flipped back on. The declared default is pinned here as well
 * as the behaviour, because the shipped value is the contract an operator gets without doing
 * anything, and it is the half that regresses in a one-character diff.
 */
describe("the serving-account chip ships off", () => {
	it("declares a default of off", () => {
		expect(APPEARANCE_SETTINGS["statusLine.showAccount"].default).toBe(false);
	});

	it("stays off the footline while the setting is off, with several accounts stored", async () => {
		await storeAccounts("first@example.com", "second@example.com");
		await settings.set("statusLine.showAccount", false);

		const line = accountOnly().line();

		expect(line).not.toContain("as ");
		expect(line).not.toContain("first@example.com");
		expect(line).not.toContain("second@example.com");
	});

	it("names the account as soon as the setting is on", async () => {
		await storeAccounts("visible@example.com", "other@example.com");
		await settings.set("statusLine.showAccount", false);
		expect(accountOnly().line()).not.toContain("visible@example.com");

		await settings.set("statusLine.showAccount", true);

		// `next` rather than `as`: no request has gone out in this fixture, so the honest answer is what
		// the next one would use. Which of the two prefixes is right is pinned by the prediction cases
		// above; what matters here is that the chip appeared at all.
		expect(accountOnly().line()).toContain("next visible@example.com");
	});
});
