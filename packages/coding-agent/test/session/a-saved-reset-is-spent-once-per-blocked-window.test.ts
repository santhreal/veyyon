/**
 * WHY: a saved Codex rate-limit reset is a finite, paid-for credit, and `ProviderUsage` spends one
 * on its own when the retry ladder hits a weekly block. The defects at that boundary share one
 * shape: a credit spent that the policy did not permit, spent twice for one block, or reported
 * wrongly after the provider answered. Two sessions on one account that both redeem double-spend; a
 * block retried after a failed redeem redeems again; a declined or unanswerable prompt that still
 * spends takes a credit the operator refused; a redeem outcome read as success when it was not makes
 * the ladder retry into the same wall, and a success read as failure leaves the session waiting out
 * a window it already paid to skip. The same collaborator records usage headers and turn cost
 * against a credential, and a record filed under the wrong session id bills the wrong account.
 *
 * The class this closes is a redeem, or a usage record, the policy and the provider's answer do not
 * account for. The outcome table is keyed by every literal code `ResetCreditRedeemCode` declares, so
 * a code added there fails to type-check until this suite states what the session does with it; the
 * cost sweep takes every bundled provider at run time.
 *
 * What it does not catch: whether `evaluateCodexAutoRedeem` judges eligibility correctly (the
 * `codex-auto-reset` suite owns every gate), whether the retry ladder calls the hook on a usage-limit
 * error (`retry-runtime`), and what each provider's reset endpoint does.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type {
	AssistantMessage,
	Model,
	OAuthAccountIdentity,
	ResetCreditRedeemCode,
	ResetCreditRedeemOutcome,
	UsageReport,
} from "@veyyon/ai";
import { type GeneratedProvider, getBundledModels, getBundledProviders } from "@veyyon/catalog/models";
import { ANTIGRAVITY_PRIMARY_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT } from "@veyyon/catalog/provider-endpoints";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { CodexAutoRedeemCoordinator } from "@veyyon/coding-agent/session/codex-auto-reset";
import {
	CODEX_AUTO_REDEEM_SOURCE,
	CODEX_AUTO_REDEEM_TIMEOUT_MS,
	ProviderUsage,
	type ProviderUsageAuth,
} from "@veyyon/coding-agent/session/runtime/provider-usage";

const DAY = 24 * 60 * 60 * 1000;
const ACCOUNT_ID = "acct-123";
const EMAIL = "user@example.com";
const IDENTITY: OAuthAccountIdentity = { accountId: ACCOUNT_ID, email: EMAIL };
const PROVIDER_SESSION = "provider-session";
const AGENT_SESSION = "agent-session";

function firstModel(provider: GeneratedProvider, predicate: (model: Model) => boolean = () => true): Model {
	const model = getBundledModels(provider).find(predicate);
	if (!model) throw new Error(`the bundled catalog holds no ${provider} model this suite needs`);
	return model;
}

const CODEX = firstModel("openai-codex", model => !model.id.includes("spark"));
const NOT_CODEX = firstModel("anthropic");

/**
 * A weekly block the policy redeems: exhausted, days from its natural reset, credits in hand.
 * `driftMs` moves the reported weekly reset, as provider jitter does between two reads.
 */
function blockedReport(credits = 2, driftMs = 0): UsageReport {
	const now = Date.now();
	return {
		provider: "openai-codex",
		fetchedAt: now,
		limits: [
			{
				id: "openai-codex:secondary",
				label: "Weekly",
				scope: { provider: "openai-codex", accountId: ACCOUNT_ID },
				window: { id: "7d", label: "Weekly", resetsAt: now + 3 * DAY + driftMs },
				amount: { usedFraction: 1, unit: "percent" },
			},
		],
		resetCredits: { availableCount: credits },
		metadata: { accountId: ACCOUNT_ID, email: EMAIL, limitReached: true },
	};
}

type Select = (title: string) => Promise<string | undefined>;

interface Harness {
	readonly usage: ProviderUsage;
	readonly settings: Settings;
	readonly coordinator: CodexAutoRedeemCoordinator;
	readonly notices: { level: string; message: string; source?: string }[];
	readonly identityLookups: (string | undefined)[];
	readonly fetches: ((provider: string) => string | undefined)[];
	readonly redeems: { signal: AbortSignal | undefined }[];
	readonly listed: (string | undefined)[];
	readonly ingested: { provider: string; headers: Record<string, string>; sessionId?: string; baseUrl?: string }[];
	readonly costs: { provider: string; cost: number; sessionId?: string; recordedAt?: number; baseUrl?: string }[];
	readonly prompts: string[];
	model: Model | undefined;
	identity: OAuthAccountIdentity | undefined;
	reports: UsageReport[] | null;
	redeem: (signal: AbortSignal | undefined) => Promise<ResetCreditRedeemOutcome>;
	select: Select | undefined;
}

function outcome(code: ResetCreditRedeemCode): ResetCreditRedeemOutcome {
	return { ok: code === "reset", code, provider: "openai-codex", accountId: ACCOUNT_ID };
}

/**
 * `autoRedeem: "unset"` is left at the schema default rather than seeded: a seeded value is a runtime
 * override, and an override outranks the value a prompt answer writes.
 */
function harness(
	settings: { "codexResets.autoRedeem"?: "unset" | "yes" | "no"; "providers.antigravityEndpoint"?: string } = {},
) {
	const { "codexResets.autoRedeem": autoRedeem = "yes", ...rest } = settings;
	const h: Omit<Harness, "usage"> = {
		settings: Settings.isolated(autoRedeem === "unset" ? rest : { "codexResets.autoRedeem": autoRedeem, ...rest }),
		coordinator: { attemptedBlockKeys: new Set(), lastAttemptAtByAccount: new Map(), inFlightByAccount: new Map() },
		notices: [],
		identityLookups: [],
		fetches: [],
		redeems: [],
		listed: [],
		ingested: [],
		costs: [],
		prompts: [],
		model: CODEX,
		identity: IDENTITY,
		reports: [blockedReport()],
		redeem: async () => outcome("reset"),
		select: undefined,
	};
	const auth: ProviderUsageAuth = {
		ingestUsageHeaders(provider, headers, options) {
			h.ingested.push({ provider, headers, sessionId: options?.sessionId, baseUrl: options?.baseUrl });
			return true;
		},
		recordUsageCost(provider, cost, options) {
			h.costs.push({
				provider,
				cost,
				sessionId: options?.sessionId,
				recordedAt: options?.recordedAt,
				baseUrl: options?.baseUrl,
			});
			return true;
		},
		async fetchUsageReports(options) {
			h.fetches.push(provider => options?.baseUrlResolver?.(provider));
			return h.reports;
		},
		redeemResetCredit(options) {
			h.redeems.push({ signal: options.signal });
			return h.redeem(options.signal);
		},
		async listResetCredits(options) {
			h.listed.push(options?.sessionId);
			return [];
		},
		getOAuthAccountIdentity(_provider, sessionId) {
			h.identityLookups.push(sessionId);
			return h.identity;
		},
	};
	const usage = new ProviderUsage({
		authStorage: () => auth,
		providerBaseUrl: provider => `https://${provider}.example`,
		settings: h.settings,
		sessionId: () => PROVIDER_SESSION,
		agentSessionId: () => AGENT_SESSION,
		model: () => h.model,
		emitNotice: (level, message, source) => {
			h.notices.push({ level, message, source });
		},
		ui: () => {
			const select = h.select;
			if (!select) return undefined;
			return {
				select: async title => {
					h.prompts.push(title);
					return select(title);
				},
			};
		},
	});
	return Object.assign(h, { usage });
}

const redeemOnce = (h: Harness) => h.usage.maybeAutoRedeemCodexReset(h.coordinator);

/** The literal members of a union that also admits any string. */
type Literal<T> = T extends string ? (string extends T ? never : T) : never;

interface OutcomeExpectation {
	retries: boolean;
	notice?: { level: "info" | "warning"; includes: string };
	/** Whether the usage report is refreshed after the redeem. */
	refreshes: boolean;
}

const failed = (code: string): OutcomeExpectation => ({
	retries: false,
	notice: { level: "warning", includes: `Codex auto-redeem failed (${code}).` },
	refreshes: false,
});

const OUTCOMES: Record<Literal<ResetCreditRedeemCode>, OutcomeExpectation> = {
	reset: { retries: true, notice: { level: "info", includes: "(1 left); retrying now." }, refreshes: true },
	already_redeemed: {
		retries: false,
		notice: { level: "warning", includes: "already redeemed elsewhere" },
		refreshes: false,
	},
	no_credit: { retries: false, refreshes: false },
	nothing_to_reset: { retries: false, notice: { level: "warning", includes: "nothing to reset" }, refreshes: false },
	cooldown: failed("cooldown"),
	ineligible: failed("ineligible"),
	unavailable: failed("unavailable"),
	no_account: failed("no_account"),
	account_unavailable: failed("account_unavailable"),
	no_organization: failed("no_organization"),
	status_unavailable: failed("status_unavailable"),
	rate_limited: failed("rate_limited"),
	auth_error: failed("auth_error"),
};

afterEach(() => {
	vi.useRealTimers();
});

describe("a saved reset is spent once per blocked window", () => {
	const cases: [string, OutcomeExpectation][] = [
		...Object.entries(OUTCOMES),
		["http_503", failed("http_503")],
		["a_code_no_client_knows_yet", failed("a_code_no_client_knows_yet")],
	];
	for (const [code, expected] of cases) {
		it(`reports a ${code} redeem as ${expected.retries ? "a retry" : "no retry"}`, async () => {
			const h = harness();
			h.redeem = async () => outcome(code);

			expect(await redeemOnce(h)).toBe(expected.retries);

			expect(h.redeems).toHaveLength(1);
			if (expected.notice) {
				expect(h.notices).toHaveLength(1);
				expect(h.notices[0]?.level).toBe(expected.notice.level);
				expect(h.notices[0]?.message).toContain(expected.notice.includes);
				expect(h.notices[0]?.source).toBe(CODEX_AUTO_REDEEM_SOURCE);
			} else {
				expect(h.notices).toEqual([]);
			}
			await Promise.resolve();
			expect(h.fetches).toHaveLength(expected.refreshes ? 2 : 1);
		});
	}

	it("never redeems a block twice, whatever the first redeem answered", async () => {
		for (const code of ["reset", "http_500", "no_credit"]) {
			const h = harness();
			h.redeem = async () => outcome(code);
			await redeemOnce(h);

			expect(await redeemOnce(h)).toBe(false);

			expect(h.redeems).toHaveLength(1);
		}
	});

	it("remembers a block after the account cooldown has passed", async () => {
		const h = harness();
		h.redeem = async () => outcome("http_500");
		await redeemOnce(h);
		// The per-account cooldown is over; only the block ledger stands between this block and a
		// second redeem.
		h.coordinator.lastAttemptAtByAccount.clear();

		expect(await redeemOnce(h)).toBe(false);

		expect(h.redeems).toHaveLength(1);
	});

	it("holds the account through its cooldown when the reported reset drifts into a new block", async () => {
		const h = harness();
		h.redeem = async () => outcome("http_500");
		await redeemOnce(h);
		h.reports = [blockedReport(2, 2 * 60_000)];

		expect(await redeemOnce(h)).toBe(false);

		expect(h.redeems).toHaveLength(1);
	});

	it("gives concurrent sessions on one account one redeem and one answer", async () => {
		const h = harness();
		const { promise, resolve } = Promise.withResolvers<ResetCreditRedeemOutcome>();
		h.redeem = () => promise;

		const first = redeemOnce(h);
		const second = redeemOnce(h);
		resolve(outcome("reset"));

		expect(await Promise.all([first, second])).toEqual([true, true]);
		expect(h.redeems).toHaveLength(1);
		expect(h.coordinator.inFlightByAccount.size).toBe(0);
	});

	it("reads the blocked account under the provider session id", async () => {
		const h = harness();
		await redeemOnce(h);
		expect(h.identityLookups).toEqual([PROVIDER_SESSION]);
	});

	it("abandons a redeem the provider has not answered by the deadline", async () => {
		vi.useFakeTimers();
		const h = harness();
		const started = Promise.withResolvers<void>();
		h.redeem = signal => {
			started.resolve();
			const answered = Promise.withResolvers<ResetCreditRedeemOutcome>();
			signal?.addEventListener("abort", () => answered.resolve(outcome("http_408")), { once: true });
			return answered.promise;
		};

		const run = redeemOnce(h);
		await started.promise;
		vi.advanceTimersByTime(CODEX_AUTO_REDEEM_TIMEOUT_MS - 1);
		expect(h.redeems[0]?.signal?.aborted).toBe(false);
		vi.advanceTimersByTime(1);

		expect(await run).toBe(false);
		expect(h.redeems[0]?.signal?.aborted).toBe(true);
	});
});

describe("a saved reset is spent only when the policy permits it", () => {
	it("does no IO at all when auto-redeem is off", async () => {
		const h = harness({ "codexResets.autoRedeem": "no" });
		expect(await redeemOnce(h)).toBe(false);
		expect([h.identityLookups, h.fetches, h.redeems]).toEqual([[], [], []]);
	});

	it("does no IO for a model that is not Codex, or no model", async () => {
		for (const model of [NOT_CODEX, undefined]) {
			const h = harness();
			h.model = model;
			expect(await redeemOnce(h)).toBe(false);
			expect([h.identityLookups, h.fetches, h.redeems]).toEqual([[], [], []]);
		}
	});

	it("fetches nothing when the blocked account has no identity", async () => {
		const h = harness();
		h.identity = undefined;
		expect(await redeemOnce(h)).toBe(false);
		expect([h.fetches, h.redeems]).toEqual([[], []]);
	});

	it("spends nothing when the policy judges the block ineligible", async () => {
		const h = harness();
		h.reports = [blockedReport(0)];
		expect(await redeemOnce(h)).toBe(false);
		expect(h.redeems).toEqual([]);
	});

	it("spends without asking when auto-redeem is yes", async () => {
		const h = harness({ "codexResets.autoRedeem": "yes" });
		h.select = async () => "No";
		expect(await redeemOnce(h)).toBe(true);
		expect(h.prompts).toEqual([]);
	});

	it("warns and spends nothing when the policy is unset and nothing can ask", async () => {
		const h = harness({ "codexResets.autoRedeem": "unset" });

		expect(await redeemOnce(h)).toBe(false);

		expect(h.redeems).toEqual([]);
		expect(h.notices.map(notice => [notice.level, notice.source])).toEqual([["warning", CODEX_AUTO_REDEEM_SOURCE]]);
		expect(h.settings.get("codexResets.autoRedeem")).toBe("unset");
	});

	const answers: [string, string | undefined | Error, boolean, "unset" | "yes" | "no"][] = [
		["Yes spends and records yes", "Yes", true, "yes"],
		["No spends nothing and records no", "No", false, "no"],
		["a dismissed prompt spends nothing and records nothing", undefined, false, "unset"],
		["a prompt that fails spends nothing and records nothing", new Error("prompt closed"), false, "unset"],
	];
	for (const [name, answer, spends, recorded] of answers) {
		it(`asks first when the policy is unset: ${name}`, async () => {
			const h = harness({ "codexResets.autoRedeem": "unset" });
			h.select = async () => {
				if (answer instanceof Error) throw answer;
				return answer;
			};

			expect(await redeemOnce(h)).toBe(spends);

			expect(h.prompts).toHaveLength(1);
			expect(h.prompts[0]).toContain(EMAIL);
			expect(h.prompts[0]).toContain("Spend 1 of 2 saved resets?");
			expect(h.redeems).toHaveLength(spends ? 1 : 0);
			expect(h.settings.get("codexResets.autoRedeem")).toBe(recorded);
		});
	}
});

describe("usage is recorded against the credential the session routes under", () => {
	function turn(provider: string, cost: number): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "openai-completions",
			provider: provider as AssistantMessage["provider"],
			model: "m",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
			},
			stopReason: "stop",
			timestamp: 42,
		};
	}

	it("records a turn's cost only for OpenCode Go, under the provider session id", () => {
		const recorded: string[] = [];
		for (const provider of getBundledProviders()) {
			const h = harness();
			h.usage.recordTurnCost(turn(provider, 0.25));
			if (h.costs.length > 0) {
				recorded.push(provider);
				expect(h.costs).toEqual([
					{
						provider,
						cost: 0.25,
						sessionId: PROVIDER_SESSION,
						recordedAt: 42,
						baseUrl: `https://${provider}.example`,
					},
				]);
			}
		}
		expect(recorded).toEqual(["opencode-go"]);
	});

	it("records response headers under the agent's session id, and none without a model", () => {
		const h = harness();
		h.usage.ingestHeaders({ status: 200, headers: { "x-ratelimit-remaining": "3" } }, undefined);
		expect(h.ingested).toEqual([]);

		h.usage.ingestHeaders({ status: 200, headers: { "x-ratelimit-remaining": "3" } }, CODEX);

		expect(h.ingested).toEqual([
			{
				provider: CODEX.provider,
				headers: { "x-ratelimit-remaining": "3" },
				sessionId: AGENT_SESSION,
				baseUrl: `https://${CODEX.provider}.example`,
			},
		]);
	});

	it("lists saved resets under the provider session id", async () => {
		const h = harness();
		await h.usage.listResetCredits();
		expect(h.listed).toEqual([PROVIDER_SESSION]);
	});

	const endpoints: [string, string][] = [
		["sandbox", ANTIGRAVITY_SANDBOX_ENDPOINT],
		["production", ANTIGRAVITY_PRIMARY_ENDPOINT],
		["auto", "https://google-antigravity.example"],
	];
	for (const [mode, expected] of endpoints) {
		it(`reads Antigravity usage from the ${mode} endpoint setting`, async () => {
			const h = harness({ "providers.antigravityEndpoint": mode });
			await h.usage.fetchReports();
			expect(h.fetches[0]?.("google-antigravity")).toBe(expected);
			expect(h.fetches[0]?.("openai-codex")).toBe("https://openai-codex.example");
		});
	}
});
