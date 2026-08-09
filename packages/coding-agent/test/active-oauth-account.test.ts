import { describe, expect, test } from "bun:test";
import type { UsageLimit, UsageReport } from "@veyyon/ai";
import {
	limitMatchesActiveAccount,
	reportMatchesActiveAccount,
} from "../src/slash-commands/helpers/active-oauth-account";

function makeLimit(scope: Partial<UsageLimit["scope"]> = {}): UsageLimit {
	return {
		id: "limit-1",
		label: "Requests",
		scope: { provider: "anthropic", ...scope },
		amount: { usedFraction: 0.5, unit: "percent" },
	};
}

function makeReport(overrides: Partial<UsageReport> = {}): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits: [makeLimit()],
		...overrides,
	};
}

describe("limitMatchesActiveAccount", () => {
	test("matches accountId against report metadata (camel and snake case) and limit scope", () => {
		const identity = { accountId: "ACC-1" };
		expect(limitMatchesActiveAccount(makeReport({ metadata: { accountId: "acc-1" } }), makeLimit(), identity)).toBe(
			true,
		);
		expect(limitMatchesActiveAccount(makeReport({ metadata: { account_id: "acc-1" } }), makeLimit(), identity)).toBe(
			true,
		);
		expect(limitMatchesActiveAccount(makeReport(), makeLimit({ accountId: "acc-1" }), identity)).toBe(true);
		expect(limitMatchesActiveAccount(makeReport({ metadata: { accountId: "acc-2" } }), makeLimit(), identity)).toBe(
			false,
		);
	});

	test("matches email against report metadata only — never against scope accountId", () => {
		const identity = { email: "user@example.com" };
		expect(
			limitMatchesActiveAccount(makeReport({ metadata: { email: "User@Example.com" } }), makeLimit(), identity),
		).toBe(true);
		// An email must not match an opaque account-id slot that happens to hold the same string.
		expect(limitMatchesActiveAccount(makeReport(), makeLimit({ accountId: "user@example.com" }), identity)).toBe(
			false,
		);
	});

	test("matches projectId for Google-style providers via scope or metadata", () => {
		const identity = { projectId: "gcp-proj-1" };
		expect(limitMatchesActiveAccount(makeReport(), makeLimit({ projectId: "gcp-proj-1" }), identity)).toBe(true);
		expect(
			limitMatchesActiveAccount(makeReport({ metadata: { projectId: "gcp-proj-1" } }), makeLimit(), identity),
		).toBe(true);
		expect(limitMatchesActiveAccount(makeReport(), makeLimit({ projectId: "gcp-proj-2" }), identity)).toBe(false);
	});

	test("returns false without an identity or with an empty identity", () => {
		expect(limitMatchesActiveAccount(makeReport({ metadata: { email: "a@b.c" } }), makeLimit(), undefined)).toBe(
			false,
		);
		expect(limitMatchesActiveAccount(makeReport({ metadata: { email: "a@b.c" } }), makeLimit(), {})).toBe(false);
	});

	test("org-scoped identity matches only its own org — not the shared email, not org-less reports", () => {
		const identity = { email: "shared@example.com", orgId: "org-team" };
		expect(
			limitMatchesActiveAccount(
				makeReport({ metadata: { email: "shared@example.com", orgId: "org-team" } }),
				makeLimit(),
				identity,
			),
		).toBe(true);
		// Same email, other org: must NOT be flagged as this session's account.
		expect(
			limitMatchesActiveAccount(
				makeReport({ metadata: { email: "shared@example.com", orgId: "org-max" } }),
				makeLimit(),
				identity,
			),
		).toBe(false);
		// Org-less report (pre-upgrade cache leftover): shared email must not attach the marker.
		expect(
			limitMatchesActiveAccount(makeReport({ metadata: { email: "shared@example.com" } }), makeLimit(), identity),
		).toBe(false);
	});

	test("org-less identity never claims an org-attributed report via the shared email", () => {
		// Reverse direction: the active session runs on a legacy bare-email row
		// while reports are org-attributed — the marker must not appear on
		// another registration's report.
		const identity = { email: "shared@example.com", accountId: "account-shared" };
		expect(
			limitMatchesActiveAccount(
				makeReport({ metadata: { email: "shared@example.com", orgId: "org-team" } }),
				makeLimit(),
				identity,
			),
		).toBe(false);
		// Both sides org-less: providers without orgs keep the email fallback.
		expect(
			limitMatchesActiveAccount(makeReport({ metadata: { email: "shared@example.com" } }), makeLimit(), identity),
		).toBe(true);
	});

	test("same org, different member: the base identity is still required — two Team seats never share the marker", () => {
		const identity = { email: "alice@example.com", accountId: "account-alice", orgId: "org-team" };
		// Anthropic Team seats have per-user pools but share the org id in
		// report metadata — the other member's report must not be flagged.
		expect(
			limitMatchesActiveAccount(
				makeReport({ metadata: { email: "bob@example.com", accountId: "account-bob", orgId: "org-team" } }),
				makeLimit(),
				identity,
			),
		).toBe(false);
		// The member's own same-org report still matches through the base identity.
		expect(
			limitMatchesActiveAccount(
				makeReport({ metadata: { email: "alice@example.com", orgId: "org-team" } }),
				makeLimit(),
				identity,
			),
		).toBe(true);
	});

	test("org-only active identity matches same-org reports on the org alone", () => {
		// Login recovered neither email nor account: the org is all the session
		// knows about itself.
		const identity = { orgId: "org-team" };
		expect(
			limitMatchesActiveAccount(
				makeReport({ metadata: { email: "bob@example.com", orgId: "org-team" } }),
				makeLimit(),
				identity,
			),
		).toBe(true);
		expect(limitMatchesActiveAccount(makeReport({ metadata: { orgId: "org-max" } }), makeLimit(), identity)).toBe(
			false,
		);
	});
});

describe("reportMatchesActiveAccount", () => {
	test("matches when any limit column belongs to the identity", () => {
		const report = makeReport({
			limits: [makeLimit({ accountId: "other" }), makeLimit({ accountId: "acc-1" })],
		});
		expect(reportMatchesActiveAccount(report, { accountId: "acc-1" })).toBe(true);
		expect(reportMatchesActiveAccount(report, { accountId: "acc-3" })).toBe(false);
	});

	test("does not match a report with no limits", () => {
		const report = makeReport({ limits: [], metadata: { email: "user@example.com" } });
		expect(reportMatchesActiveAccount(report, { email: "user@example.com" })).toBe(false);
	});
});
