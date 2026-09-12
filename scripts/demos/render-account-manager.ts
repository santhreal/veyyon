/**
 * Render the account manager component across credential and usage states as ANSI text.
 *
 * Populates an isolated SQLite credential store with mock Anthropic, OpenAI Codex, and
 * Groq accounts. Renders the account manager in several interactive configurations,
 * including healthy accounts, failing credentials, logout armed state, inline account
 * renaming, sidebar navigation, and rate-limited fallback serving.
 *
 * Usage:
 *   bun scripts/demos/render-account-manager.ts [--only <substring>] [--width 100] [--theme titanium]
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CredentialHealthResult } from "../../packages/ai/src/auth-storage";
import { AuthStorage, SqliteAuthCredentialStore } from "../../packages/ai/src/auth-storage";
import type { UsageReport } from "../../packages/ai/src/usage";
import { AccountManagerComponent } from "../../packages/coding-agent/src/modes/terminal/components/account/account-manager";
import {
	applyCredentialHealth,
	applyUsageReports,
	buildAccountInventory,
} from "../../packages/coding-agent/src/session/account-inventory";
import { theme } from "../../packages/coding-agent/src/theme/theme";
import { renderDemo } from "./render-args";

const NOW = Date.now();
const HOUR = 60 * 60_000;
const SESSION = "proof-session";
const ROWS = 40;

function limit(
	id: string,
	label: string,
	usedFraction: number,
	windowLabel: string,
	resetsInMs: number,
	tier: string,
	accountId: string,
) {
	return {
		id,
		label,
		amount: { unit: "percent" as const, usedFraction, used: usedFraction * 100 },
		window: { label: windowLabel, resetsAt: NOW + resetsInMs },
		scope: { accountId, tier, windowId: windowLabel },
		status: "ok" as const,
	};
}

const usage: UsageReport[] = [
	{
		provider: "anthropic",
		fetchedAt: NOW,
		metadata: { email: "first-account@example.com", accountId: "acct-work", orgId: "org-example" },
		limits: [
			limit("5h", "Claude 5 Hour", 0.71, "5h", 2 * HOUR, "Max 20x", "acct-work"),
			limit("7d", "Claude 7 Day", 0.34, "7d", 4 * 24 * HOUR, "Max 20x", "acct-work"),
		],
	},
	{
		provider: "anthropic",
		fetchedAt: NOW,
		metadata: { email: "second-account@example.com", accountId: "acct-personal" },
		limits: [limit("5h", "Claude 5 Hour", 0.18, "5h", 4 * HOUR, "Pro", "acct-personal")],
	},
	{
		provider: "openai-codex",
		fetchedAt: NOW,
		metadata: { email: "first-account@example.com", accountId: "acct-codex" },
		limits: [limit("5h", "Codex 5 Hour", 0.44, "5h", HOUR, "Plus", "acct-codex")],
	},
] as unknown as UsageReport[];

const noop = () => {};
const callbacks = {
	onUseAccount: noop,
	onRename: noop,
	onRefresh: noop,
	onLogout: noop,
	onShowUsage: noop,
	onAddAccount: noop,
	onClearRateLimitBlock: noop,
	onCancel: noop,
};

await renderDemo(
	async ({ width, flag }) => {
		const only = flag("only", "");
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-proof-accounts-"));
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const authStorage = new AuthStorage(store);

		try {
			await authStorage.set("anthropic", [
				{
					type: "oauth",
					access: "proof-access-work",
					refresh: "proof-refresh-work",
					expires: NOW + 8 * HOUR,
					accountId: "acct-work",
					email: "first-account@example.com",
					orgId: "org-example",
					orgName: "Example Org",
				},
				{
					type: "oauth",
					access: "proof-access-personal",
					refresh: "proof-refresh-personal",
					expires: NOW + 8 * HOUR,
					accountId: "acct-personal",
					email: "second-account@example.com",
				},
				{
					type: "oauth",
					access: "proof-access-stale",
					refresh: "proof-refresh-stale",
					expires: NOW - HOUR,
					accountId: "acct-revoked",
					email: "revoked-account@example.invalid",
					orgId: "org-former",
					orgName: "Former Org",
				},
			]);
			await authStorage.set("openai-codex", [
				{
					type: "oauth",
					access: "proof-access-codex",
					refresh: "proof-refresh-codex",
					expires: NOW + 8 * HOUR,
					accountId: "acct-codex",
					email: "first-account@example.com",
				},
			]);
			await authStorage.set("groq", [{ type: "api_key", key: "proof-groq-key" }]);

			const anthropicRows = authStorage.listStoredCredentials("anthropic");
			const workId = anthropicRows[0]!.id;
			const personalId = anthropicRows[1]!.id;
			const staleId = anthropicRows[2]!.id;
			const codexId = authStorage.listStoredCredentials("openai-codex")[0]!.id;

			authStorage.setAccountName("anthropic", workId, "work");
			authStorage.setAccountName("anthropic", personalId, "personal");
			authStorage.setAccountName("openai-codex", codexId, "codex-main");

			const health: CredentialHealthResult[] = [
				{ id: workId, provider: "anthropic", type: "oauth", ok: true, email: "first-account@example.com" },
				{ id: personalId, provider: "anthropic", type: "oauth", ok: true, email: "second-account@example.com" },
				{
					id: staleId,
					provider: "anthropic",
					type: "oauth",
					ok: false,
					email: "revoked-account@example.invalid",
					reason: "invalid_grant: refresh token revoked",
				},
				{ id: codexId, provider: "openai-codex", type: "oauth", ok: true, email: "first-account@example.com" },
			];

			function inventoryNow() {
				let inventory = buildAccountInventory(authStorage, { sessionId: SESSION });
				inventory = applyCredentialHealth(inventory, health);
				return applyUsageReports(inventory, usage);
			}

			const lines: string[] = [];
			function section(
				title: string,
				drive: (component: AccountManagerComponent) => void,
				initialProviderId = "anthropic",
			) {
				if (only && !title.includes(only)) return;
				const component = new AccountManagerComponent(inventoryNow(), callbacks, {
					initialProviderId,
					terminalHeight: ROWS,
				});
				component.render(width);
				drive(component);
				lines.push(theme.fg("dim", `── ${title}`), ...component.render(width), "");
				component.dispose();
			}

			section("three Anthropic accounts, one failing", () => {});
			section("logout armed on the selected account", component => component.handleInput("x"));
			section("naming the selected account", component => {
				for (const c of "team") component.handleInput(c);
			});
			section("sidebar focused", component => component.handleInput("\x1b[D"));
			section("an api-key provider with no OAuth identity", () => {}, "groq");

			if (!only || "the chosen account serves through its rate limit".includes(only)) {
				await authStorage.removeCredential("anthropic", staleId);
				authStorage.pinSessionCredential("anthropic", SESSION, workId);
				await authStorage.markUsageLimitReached("anthropic", SESSION, {
					credentialId: workId,
					retryAfterMs: 2 * HOUR,
				});
				await authStorage.getApiKey("anthropic", SESSION);
				section("the chosen account serves through its rate limit", () => {});
			}

			return lines;
		} finally {
			store.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	},
	{ settings: true },
);
