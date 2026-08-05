/**
 * Print the `/providers` account manager, one state per section.
 *
 * The card's whole claim is that several credentials per provider become several READABLE rows,
 * so what has to be judged is a thing you see: whether the glyph, the label, the identity, the
 * plan, the origin badge and two usage bars per account still read as one row at a glance when
 * three accounts of one provider sit on top of each other, and whether a failed account and a
 * rate-limited one are tellable apart without reading the words. The string assertions in
 * `test/modes/components/account-manager.test.ts` pin the bytes; they cannot answer that.
 *
 * Run:
 *     env -u NO_COLOR FORCE_COLOR=3 bun scripts/demos/render-account-manager.ts --width 110 |
 *       bun scripts/demos/render-proof.ts --out /tmp/account-manager --width 110 --scale 3
 *
 * The store is a REAL `SqliteAuthCredentialStore` in a temp directory, and the rows come from
 * `buildAccountInventory` through the same two enrichment passes the live card uses, so what
 * renders is what the component loads through its own code path rather than a hand-built fixture
 * that could disagree with it.
 *
 * Two things are pinned so the proof re-takes identically. Every deadline is written as an OFFSET
 * from one captured `NOW`, because the countdowns ("resets in 2h") are rendered against
 * `Date.now()` and a fixture pinned to an absolute instant drifts a little further from its
 * expected text every day. And every section names its terminal height: a piped render has no
 * `process.stdout.rows`, and the compact card a short terminal produces is two columns WIDER than
 * the ordinary one, so an overflowing line can render as fitting. That mistake has been made in
 * this directory before, which is why `AccountManagerOptions.terminalHeight` exists.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CredentialHealthResult, UsageReport } from "../../packages/ai/src/auth-storage";
import { AuthStorage, SqliteAuthCredentialStore } from "../../packages/ai/src/auth-storage";
import { AccountManagerComponent } from "../../packages/coding-agent/src/modes/components/account-manager";
import { theme } from "../../packages/coding-agent/src/modes/theme/theme";
import {
	applyCredentialHealth,
	applyUsageReports,
	buildAccountInventory,
} from "../../packages/coding-agent/src/session/account-inventory";
import { flag, initRender, renderWidth } from "./render-args";

const themeName = flag("theme", "titanium");
const width = renderWidth();
const only = flag("only", "");
await initRender(themeName, { settings: true });

/** One captured instant. Every deadline below is an offset from it, so countdowns are stable. */
const NOW = Date.now();
const HOUR = 60 * 60_000;
const SESSION = "proof-session";
/**
 * Forty rows, named rather than inherited. See the header: a piped render reads no terminal
 * height, and the compact card is not the card an operator sees.
 */
const ROWS = 40;

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-proof-accounts-"));
const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
const authStorage = new AuthStorage(store);

// Three Anthropic accounts, because one provider holding several accounts is the case the card
// exists for and the case the old provider list could not render at all. Two share nothing, and
// the third is deliberately broken.
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
// An api-key row, so the origin badge has something to distinguish. A key-authenticated account
// carries no OAuth identity at all, which is the row whose label has to fall through the ladder.
await authStorage.set("groq", [{ type: "api_key", key: "proof-groq-key" }]);

const anthropicRows = authStorage.listStoredCredentials("anthropic");
const workId = anthropicRows[0]!.id;
const personalId = anthropicRows[1]!.id;
const staleId = anthropicRows[2]!.id;
const codexId = authStorage.listStoredCredentials("openai-codex")[0]!.id;

authStorage.setAccountName("anthropic", workId, "work");
authStorage.setAccountName("anthropic", personalId, "personal");
authStorage.setAccountName("openai-codex", codexId, "codex-main");

/** Health as a probe would report it: two good, one refused with the upstream words kept. */
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

/** Usage as the provider reports it: several windows per account, tiers included. */
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

function inventoryNow() {
	let inventory = buildAccountInventory(authStorage, { sessionId: SESSION });
	inventory = applyCredentialHealth(inventory, health);
	return applyUsageReports(inventory, usage);
}

const noop = () => {};
const callbacks = {
	onUseAccount: noop,
	onRename: noop,
	onRefresh: noop,
	onLogout: noop,
	onShowUsage: noop,
	onAddAccount: noop,
	onCancel: noop,
};

async function section(
	title: string,
	drive: (component: AccountManagerComponent) => void,
	initialProviderId = "anthropic",
): Promise<void> {
	if (only && !title.includes(only)) return;
	const component = new AccountManagerComponent(inventoryNow(), callbacks, {
		initialProviderId,
		terminalHeight: ROWS,
	});
	// One render before driving, so any state a key toggles is computed against a laid-out card
	// rather than against the zeroed geometry of a component that has never painted.
	component.render(width);
	drive(component);
	process.stdout.write(`${theme.fg("dim", `── ${title}`)}\n`);
	process.stdout.write(`${component.render(width).join("\n")}\n\n`);
	component.dispose();
}

// The ordinary card, and the one that has to be legible: three accounts of one provider, each
// with its own identity, plan, origin and usage, and one of them failing.
await section("three Anthropic accounts, one failing", () => {});

// The destructive path. `x` arms rather than acts, so the confirmation line has to be impossible
// to miss on a card that is otherwise all quiet dim text.
await section("logout armed on the selected account", component => {
	component.handleInput("x");
});

// The inline rename, which is the only editable field on the card and has to read as one.
await section("naming the selected account", component => {
	component.handleInput("n");
	component.handleInput("t");
	component.handleInput("e");
	component.handleInput("a");
	component.handleInput("m");
});

// The sidebar with focus, so the two panes' cursors are visibly different things.
await section("sidebar focused", component => {
	component.handleInput("\x1b[D");
});

// A provider holding exactly one account, and an api-key row: the label ladder's last rungs and
// the `api key` origin badge rather than `login`.
await section("an api-key provider with no OAuth identity", () => {}, "groq");

// A rate-limit rotation. The pin is Anthropic `work`, its 5h window is exhausted, and the block
// is live, so the card must report the rotation instead of showing `personal` as a choice.
if (!only || "a pin rotated off by a rate limit".includes(only)) {
	authStorage.pinSessionCredential("anthropic", SESSION, workId);
	await authStorage.markUsageLimitReached("anthropic", SESSION, { credentialId: workId, retryAfterMs: 2 * HOUR });
	// Resolve once so a sibling becomes the last-used record; without this there is no rotation to
	// report, only a blocked pin.
	await authStorage.getApiKey("anthropic", SESSION);
	await section("a pin rotated off by a rate limit", () => {});
}

store.close();
await fs.rm(tempDir, { recursive: true, force: true });
