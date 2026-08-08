/**
 * Seed fabricated accounts for the account manager recording.
 *
 * The card exists to answer questions an operator can only ask when a provider holds SEVERAL
 * accounts: which one is spending this session, which one is failing, and how much of each
 * subscription is left. Recorded against an empty store it shows the empty state, which is a real
 * state but not the one the tape is about. So this seeds three Anthropic logins, one Codex login
 * and one api-key provider, and names two of them, through the product's own `AuthStorage`.
 *
 * The store is opened through `discoverAuthStorage`, not by joining a path, because the credential
 * store is machine-wide when profile sharing is on: a seeder that computes its own path can write
 * somewhere the running app never reads, and a seeder that computes it WRONG writes fabricated
 * logins into the operator's real store. The recorder runs this under a throwaway HOME for the same
 * reason; both halves have to agree, and the only way to guarantee that is to ask the product.
 *
 * Every token here is inert and authenticates to nothing. They are shaped like real credentials so
 * the label ladder, the origin badge and the expiry column have something realistic to render.
 *
 * Run it the way the recorder does:
 *
 *   bun scripts/demos/seed-account-manager.ts --profile demo
 */

import * as os from "node:os";
import * as path from "node:path";
import { discoverAuthStorage } from "../../packages/coding-agent/src/session/auth-broker-config";

function flag(name: string, fallback: string): string {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const profile = flag("profile", "demo");
const home = os.homedir();
if (!home.startsWith("/tmp/")) {
	throw new Error(
		`refusing to seed fabricated logins into a real home (${home}). ` +
			`Run this through scripts/demos/record-account-manager.sh, which owns the throwaway HOME.`,
	);
}

const agentDir = path.join(home, ".veyyon", "profiles", profile, "agent");
const authStorage = await discoverAuthStorage(agentDir);

const HOUR = 60 * 60_000;
const NOW = Date.now();

// Three Anthropic accounts, because one provider holding several is the case the card exists for.
// Two are healthy and share nothing; the third is expired, which is the row whose health line has
// to say something an operator can act on.
await authStorage.set("anthropic", [
	{
		type: "oauth",
		access: "demo-anthropic-work-access",
		refresh: "demo-anthropic-work-refresh",
		expires: NOW + 6 * HOUR,
		email: "maya@northwind.example",
		plan: "max",
	},
	{
		type: "oauth",
		access: "demo-anthropic-personal-access",
		refresh: "demo-anthropic-personal-refresh",
		expires: NOW + 4 * HOUR,
		email: "maya.k@fastmail.example",
		plan: "pro",
	},
	{
		type: "oauth",
		access: "demo-anthropic-stale-access",
		refresh: "demo-anthropic-stale-refresh",
		expires: NOW - 2 * HOUR,
		email: "ops@northwind.example",
		plan: "team",
	},
]);

await authStorage.set("openai-codex", [
	{
		type: "oauth",
		access: "demo-codex-access",
		refresh: "demo-codex-refresh",
		expires: NOW + 5 * HOUR,
		email: "maya@northwind.example",
		plan: "plus",
	},
]);

// An api-key row, so the origin badge has something to distinguish and the label ladder has to
// fall all the way through: a key carries no OAuth identity at all.
await authStorage.set("groq", [{ type: "api_key", key: "demo-groq-key" }]);

const anthropic = authStorage.listStoredCredentials("anthropic");
const codex = authStorage.listStoredCredentials("openai-codex");
const work = anthropic[0];
const personal = anthropic[1];
const codexRow = codex[0];
if (!work || !personal || !codexRow) throw new Error("seed did not land: the store reports fewer rows than were set");

authStorage.setAccountName("anthropic", work.id, "work");
authStorage.setAccountName("anthropic", personal.id, "personal");
authStorage.setAccountName("openai-codex", codexRow.id, "codex-main");

// The session routes to `work`, so the card has a pin to report rather than a bare list.
authStorage.selectProviderCredential("anthropic", work.id);

process.stdout.write(
	`seeded ${anthropic.length} anthropic, ${codex.length} openai-codex and 1 groq account under ${home}\n`,
);
