/**
 * A usage report whose metadata identities are empty strings still attributes to
 * the scoped account.
 *
 * From PR 3318: the provider sends identity fields that are present but empty,
 * which is not the same as absent, and a truthiness-free read took the empty
 * string as the account name. The limits then belonged to nobody, so the usage
 * display showed a report it could not attribute.
 */
import { describe, expect, it } from "bun:test";
import type { UsageReport } from "@veyyon/ai";
import { buildUsageReportText } from "@veyyon/coding-agent/slash-commands/helpers/usage-report";

describe("usage limits with empty metadata identities", () => {
	it("falls back to scoped account when metadata identities are empty strings", async () => {
		const report: UsageReport = {
			provider: "test-provider",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "daily",
					label: "Daily",
					scope: { provider: "test-provider", accountId: "scoped-account", projectId: "scoped-project" },
					amount: { used: 1, usedFraction: 0.1, unit: "requests" },
				},
			],
			metadata: { email: "", accountId: "", projectId: "" },
		};
		const text = await buildUsageReportText({
			session: { model: undefined, fetchUsageReports: async () => [report] },
		} as never);

		expect(text).toContain("scoped-account: 1.00 requests used");
		expect(text).not.toContain("account 1: 1.00 requests used");
	});
});
