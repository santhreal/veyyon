/**
 * `/usage` prints every provider's limits, saved resets and limitless accounts as one text block
 * (`renderUsageReports`). The renderer groups the reports twice, by provider and then by limit title and
 * window, and both groupings set an order a reader relies on to pick the account to switch to.
 *
 * Contracts:
 *  - providers appear least used first, ties ordered by provider id;
 *  - a provider's limits of one title and window form one row, its accounts ordered most used first, a limit
 *    with no used fraction last, ties in report order, the session's account marked;
 *  - every row of a provider shares one column width and fits the available width;
 *  - a single-account row prints its reset time, a multi-account row prints it per column only;
 *  - saved resets list each account holding at least one, with each credit's expiry, a credit whose expiry
 *    does not parse omitted, and the session's account marked by account id or by email;
 *  - an account with no limits prints one "no limits" line with its plan;
 *  - the session's account is named under its provider by email, then account id, then project id;
 *  - notes print on one line each, newlines collapsed and the line truncated.
 *
 * Gap: bar glyphs, colours and the aggregate amount text are asserted only through width, order and the
 * line they sit on, not byte for byte.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageLimit, UsageReport } from "@veyyon/ai";
import type { OAuthAccountIdentity } from "@veyyon/ai/auth-storage";
import { renderUsageReports } from "@veyyon/coding-agent/modes/terminal/controllers/command-controller";
import { formatProviderName } from "@veyyon/coding-agent/session/account-format";
import { initTheme, theme } from "@veyyon/coding-agent/theme/theme";
import { formatDuration } from "@veyyon/utils";
import { visibleWidth } from "@veyyon/utils/width";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;

beforeAll(async () => {
	await initTheme();
});

interface LimitSpec {
	label?: string;
	fraction?: number;
	/** `null` drops the window, leaving only the scope's window id. */
	window?: { id: string; label: string; resetsAt?: number } | null;
	scopeWindowId?: string;
	tier?: string;
	notes?: string[];
}

function limit(spec: LimitSpec = {}): UsageLimit {
	const window = spec.window === undefined ? { id: "5h", label: "5 Hour" } : spec.window;
	return {
		id: window?.id ?? spec.scopeWindowId ?? "default",
		label: spec.label ?? "Requests",
		scope: { provider: "anthropic", windowId: spec.scopeWindowId, tier: spec.tier },
		window: window ?? undefined,
		amount: { unit: "percent", usedFraction: spec.fraction },
		status: "ok",
		notes: spec.notes,
	};
}

function report(
	provider: UsageReport["provider"],
	metadata: Record<string, unknown>,
	limits: UsageLimit[],
	extra: Partial<Pick<UsageReport, "resetCredits" | "notes" | "fetchedAt">> = {},
): UsageReport {
	return { provider, fetchedAt: NOW - 5 * MINUTE, limits, metadata, ...extra };
}

function render(
	reports: UsageReport[],
	options: { width?: number; active?: (provider: string) => OAuthAccountIdentity | undefined } = {},
): string[] {
	return stripVTControlCharacters(renderUsageReports(reports, theme, NOW, options.width ?? 200, options.active)).split(
		"\n",
	);
}

function lineIndex(lines: string[], text: string): number {
	const index = lines.indexOf(text);
	expect(index).toBeGreaterThanOrEqual(0);
	return index;
}

const date = (ms: number) => new Date(ms).toISOString();

describe("provider order", () => {
	it("lists providers least used first, summing every account's limits, ties by provider id", () => {
		const lines = render([
			report("zai", { email: "z1@example.test" }, [limit({ fraction: 0.3 })]),
			report("openai-codex", { email: "o@example.test" }, [limit({ fraction: 0.5 })]),
			report("zai", { email: "z2@example.test" }, [limit({ fraction: 0.3 })]),
			report("anthropic", { email: "a@example.test" }, [limit({ fraction: 0.5 })]),
		]);
		const order = ["anthropic", "openai-codex", "zai"].map(provider =>
			lineIndex(lines, formatProviderName(provider)),
		);
		expect(order).toEqual([...order].sort((a, b) => a - b));
		// Both zai accounts land in the zai section.
		const zaiStart = order[2]!;
		expect(lines.slice(zaiStart).join("\n")).toContain("z1@example.test");
		expect(lines.slice(zaiStart).join("\n")).toContain("z2@example.test");
	});

	it("titles the block with the age of the newest report", () => {
		const lines = render([
			report("anthropic", { email: "a@example.test" }, [limit()], { fetchedAt: NOW - 10 * MINUTE }),
			report("anthropic", { email: "b@example.test" }, [limit()], { fetchedAt: NOW - 5 * MINUTE }),
		]);
		expect(lines[0]).toBe(`Usage (${formatDuration(5 * MINUTE)} ago)`);
		expect(render([report("anthropic", {}, [limit()], { fetchedAt: 0 })])[0]).toBe("Usage");
	});
});

describe("limit rows", () => {
	const title = (text: string) => `${theme.status.success} ${text}`;

	it("orders a row's accounts most used first, an unknown fraction last, ties in report order", () => {
		const lines = render(
			[
				report("anthropic", { email: "a@example.test" }, [limit({ fraction: 0.2 })]),
				report("anthropic", { email: "b@example.test" }, [limit({ fraction: 0.7 })]),
				report("anthropic", { email: "c@example.test" }, [limit({})]),
				report("anthropic", { email: "d@example.test" }, [limit({ fraction: 0.7 })]),
			],
			{ active: () => ({ email: "d@example.test" }) },
		);
		const header = lines[lineIndex(lines, title("Requests (5 Hour)")) + 1]!;
		const columns = ["b", "d", "a", "c"].map(name => header.indexOf(`${name}@example.test`));
		expect(columns.every(column => column >= 0)).toBe(true);
		expect(columns).toEqual([...columns].sort((x, y) => x - y));
		expect(header).toContain(`${theme.status.active} d@example.test`);
		expect(header).not.toContain(`${theme.status.active} b@example.test`);
	});

	it("puts limits of one title and window on one row and splits rows by window and tier", () => {
		const lines = render([
			report("anthropic", { email: "a@example.test" }, [
				limit({ fraction: 0.1 }),
				limit({ fraction: 0.1, window: { id: "7d", label: "7 Day" } }),
				limit({ fraction: 0.1, tier: "pro" }),
			]),
			report("anthropic", { email: "b@example.test" }, [
				limit({ fraction: 0.2 }),
				limit({ fraction: 0.2, window: { id: "7d", label: "7 Day" } }),
			]),
		]);
		const titles = lines.filter(line => line.startsWith(`${theme.status.success} Requests`));
		expect(titles).toEqual([title("Requests (5 Hour)"), title("Requests (7 Day)"), title("Requests (pro) (5 Hour)")]);
		for (const [row, accounts] of [
			["Requests (5 Hour)", ["a", "b"]],
			["Requests (7 Day)", ["a", "b"]],
			["Requests (pro) (5 Hour)", ["a"]],
		] as const) {
			const header = lines[lineIndex(lines, title(row)) + 1]!;
			for (const name of ["a", "b"]) {
				expect(header.includes(`${name}@example.test`)).toBe((accounts as readonly string[]).includes(name));
			}
		}
	});

	it("groups a limit with no window by its scope window id, and one with neither as default", () => {
		const lines = render([
			report("anthropic", { email: "a@example.test" }, [
				limit({ label: "Quota", window: null, scopeWindowId: "w1" }),
			]),
			report("anthropic", { email: "b@example.test" }, [
				limit({ label: "Quota", window: null, scopeWindowId: "w1" }),
			]),
			report("anthropic", { email: "c@example.test" }, [limit({ label: "Quota", window: null })]),
		]);
		const titles = lines.filter(line => line.includes("Quota"));
		expect(titles).toEqual([title("Quota (w1)"), title("Quota (default)")]);
		const w1Header = lines[lineIndex(lines, title("Quota (w1)")) + 1]!;
		expect(w1Header).toContain("a@example.test");
		expect(w1Header).toContain("b@example.test");
		expect(w1Header).not.toContain("c@example.test");
	});

	it("gives every row of a provider the column width of its widest row, within the available width", () => {
		const width = 80;
		const lines = render(
			[
				report("anthropic", { email: "a@example.test" }, [
					limit({ fraction: 0.1 }),
					limit({ label: "Monthly", fraction: 0.5, window: { id: "monthly", label: "Monthly" } }),
				]),
				report("anthropic", { email: "b@example.test" }, [limit({ fraction: 0.2 })]),
				report("anthropic", { email: "c@example.test" }, [limit({ fraction: 0.3 })]),
			],
			{ width },
		);
		const wideBars = lines[lineIndex(lines, title("Requests (5 Hour)")) + 2]!;
		const narrowBars = lines[lineIndex(lines, title("Monthly")) + 2]!;
		expect(wideBars.endsWith(" 80% free")).toBe(true);
		expect(narrowBars.endsWith(" 50% free")).toBe(true);
		// `  ` + three bars joined by spaces + ` 80% free`; `  ` + one bar + ` 50% free`.
		const wideColumn = (visibleWidth(wideBars) - 2 - 2 - " 80% free".length) / 3;
		const narrowColumn = visibleWidth(narrowBars) - 2 - " 50% free".length;
		expect(narrowColumn).toBe(wideColumn);
		expect(visibleWidth(wideBars)).toBeLessThanOrEqual(width);
	});

	it("prints the reset time under a single-account row only", () => {
		const resetsAt = NOW + HOUR;
		const lines = render([
			report("anthropic", { email: "a@example.test" }, [
				limit({ fraction: 0.1, window: { id: "5h", label: "5 Hour", resetsAt } }),
				limit({ label: "Monthly", fraction: 0.1, window: { id: "monthly", label: "Monthly", resetsAt } }),
			]),
			report("anthropic", { email: "b@example.test" }, [
				limit({ fraction: 0.2, window: { id: "5h", label: "5 Hour", resetsAt } }),
			]),
		]);
		const resetLine = `  resets in ${formatDuration(HOUR)}`;
		expect(lines[lineIndex(lines, title("Monthly")) + 3]).toBe(resetLine);
		expect(lines.filter(line => line === resetLine)).toHaveLength(1);
	});
});

describe("saved resets", () => {
	const reports = () => [
		report("anthropic", { email: "a@example.test", accountId: "acct-a" }, [limit({ fraction: 0.1 })], {
			resetCredits: {
				availableCount: 1,
				credits: [
					{ expiresAt: date(NOW + 2 * HOUR) },
					{ expiresAt: date(NOW) },
					{ expiresAt: date(NOW - MINUTE) },
					{ expiresAt: "not-a-date" },
					{ expiresAt: "" },
					{},
				],
			},
		}),
		report("anthropic", { accountId: "acct-b" }, [limit({ fraction: 0.2 })], {
			resetCredits: { availableCount: 2 },
		}),
		report("anthropic", { email: "c@example.test" }, [limit({ fraction: 0.3 })], {
			resetCredits: { availableCount: 0 },
		}),
		report("anthropic", {}, [limit({ fraction: 0.4 })], { resetCredits: { availableCount: 1 } }),
	];
	const section = (active?: OAuthAccountIdentity) => {
		const lines = render(reports(), { active: () => active });
		const start = lineIndex(lines, "  Saved rate-limit resets (/usage reset to spend)");
		return lines.slice(start + 1, start + 7);
	};

	it("lists every account holding a reset with each parseable credit expiry", () => {
		expect(section()).toEqual([
			"    • a@example.test: 1 saved reset",
			`        expires in ${formatDuration(2 * HOUR)} (${date(NOW + 2 * HOUR).slice(0, 10)})`,
			`        expired (${date(NOW).slice(0, 10)})`,
			`        expired (${date(NOW - MINUTE).slice(0, 10)})`,
			"    • acct-b: 2 saved resets",
			"    • account: 1 saved reset",
		]);
		expect(render(reports()).filter(line => line.includes("saved reset"))).toHaveLength(3);
	});

	it("marks the session's account by email or by account id", () => {
		expect(section({ email: "a@example.test", accountId: "acct-z" })[0]).toBe(
			"    • a@example.test: 1 saved reset (active)",
		);
		expect(section({ accountId: "acct-b" })[4]).toBe("    • acct-b: 2 saved resets (active)");
	});

	it("marks no account when the session's account matches none, whichever identity field it lacks", () => {
		for (const active of [{ accountId: "acct-z" }, { email: "z@example.test" }, {}]) {
			expect(section(active).some(line => line.includes("(active)"))).toBe(false);
		}
	});

	it("prints no saved-resets heading for a provider without resets", () => {
		const lines = render([report("anthropic", { email: "a@example.test" }, [limit({ fraction: 0.1 })])]);
		expect(lines.some(line => line.includes("Saved rate-limit resets"))).toBe(false);
	});
});

describe("accounts and notes", () => {
	it("prints one no-limits line for an account without limits, with its plan when the plan is text", () => {
		const lines = render([
			report("anthropic", { email: "e@example.test", planType: "enterprise" }, []),
			report("anthropic", { email: "f@example.test", planType: "" }, []),
			report("anthropic", { email: "g@example.test", planType: 3 }, []),
			report("anthropic", { email: "h@example.test" }, [limit({ fraction: 0.1 })]),
		]);
		const ok = theme.status.success;
		expect(lines.filter(line => line.endsWith("-- no limits"))).toEqual([
			`${ok} e@example.test (enterprise) -- no limits`,
			`${ok} f@example.test -- no limits`,
			`${ok} g@example.test -- no limits`,
		]);
	});

	it("names the session's account under its own provider by email, then account id, then project id", () => {
		const identities: [OAuthAccountIdentity | undefined, string | undefined][] = [
			[{ email: "a@example.test", accountId: "acct-a", projectId: "proj-a" }, "a@example.test"],
			[{ accountId: "acct-a", projectId: "proj-a" }, "acct-a"],
			[{ projectId: "proj-a" }, "proj-a"],
			[{}, undefined],
			[undefined, undefined],
		];
		for (const [identity, expected] of identities) {
			const lines = render(
				[
					report("anthropic", { email: "a@example.test" }, [limit({ fraction: 0.1 })]),
					report("zai", { email: "z@example.test" }, [limit({ fraction: 0.9 })]),
				],
				{ active: provider => (provider === "anthropic" ? identity : undefined) },
			);
			const inUse = lines.filter(line => line.startsWith("  in use by this session:"));
			if (expected === undefined) {
				expect(inUse).toEqual([]);
			} else {
				expect(inUse).toEqual([`  in use by this session: ${expected}`]);
				expect(lines.indexOf(inUse[0]!)).toBe(lineIndex(lines, formatProviderName("anthropic")) + 1);
			}
		}
	});

	it("prints each note on one line with newlines collapsed and the line truncated", () => {
		const long = "x".repeat(140);
		const lines = render([
			report("anthropic", { email: "a@example.test" }, [limit({ fraction: 0.1, notes: [long] })], {
				notes: ["Overage\nrequests: 3"],
			}),
		]);
		expect(lines).toContain("  Overage requests: 3");
		const noteLine = lines.find(line => line.includes("xxxx"))!;
		expect(visibleWidth(noteLine)).toBeLessThanOrEqual(2 + 110);
	});
});
