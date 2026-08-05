/**
 * Seed a vault and an expansion log for the Secret Manager recording.
 *
 * The card is worth recording only when it has something to show: several credentials spread
 * across the three scopes, with different lifetimes, and a log holding uses that are not all the
 * same shape. A demo against an empty vault records the empty state, which is a real state but
 * not the one the tape claims to be about.
 *
 * The credentials are stored by running the product's own `/secret add` command, not by calling
 * the vault library directly. That distinction is not stylistic. A vault entry is sealed against
 * the location it lives in, so a fixture written by a parallel caller can seal under a binding the
 * running app then refuses, which is exactly what happened here: every seeded scope came up as
 * "this vault could not be decrypted" until the app rewrote it. Driving the real command makes the
 * binding correct by construction and means the recording proves the path a user actually walks.
 *
 * The expansion log is still written through `SecretAuditLog`, because there is no user-facing way
 * to fabricate a history of past uses. It is plain JSONL and carries no such binding.
 *
 * The values here are fabricated and inert. They are shaped like real credentials so the masking
 * has something realistic to hide, and they authenticate to nothing.
 *
 * Run it the way the driver does:
 *
 *   bun scripts/demos/seed-secret-manager.ts --profile demo --cwd /tmp/some-project
 */

import * as path from "node:path";
import { $ } from "bun";
import { SecretAuditLog, secretAuditPath } from "../../packages/coding-agent/src/secrets/audit";
import { resolveVaultLocations } from "../../packages/coding-agent/src/secrets/vault";

function flag(name: string, fallback: string): string {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const profile = flag("profile", "demo");
const cwd = flag("cwd", process.cwd());
// Derived from $HOME, never from VEYYON_HOME. The product has no such knob, so honouring one
// here points the audit log at a directory the running app never reads, and the recording shows
// an empty log while the entries sit somewhere else.
const veyyonHome = path.join(process.env.HOME ?? "", ".veyyon");

const locations = resolveVaultLocations({
	globalConfigRoot: veyyonHome,
	agentDir: path.join(veyyonHome, "profiles", profile, "agent"),
	cwd,
});

const cli = path.join(import.meta.dir, "..", "..", "packages", "coding-agent", "src", "cli.ts");

/**
 * Store one credential by running the real command, and fail loudly if it did not land.
 *
 * The value travels in the environment rather than on the command line, because `--from-env` is
 * the only way to add a secret without the value appearing in a process listing.
 */
async function addSecret(name: string, value: string, scope: string, ttl: string): Promise<void> {
	const variable = `VEYYON_DEMO_SEED_${name}`;
	const result =
		await $`${process.execPath} ${cli} --profile ${profile} --cwd ${cwd} -p ${`/secret add ${name} --from-env ${variable} --scope ${scope} --ttl ${ttl}`}`
			.env({ ...process.env, [variable]: value })
			.quiet()
			.nothrow();
	// The command says "Stored" for a new name and "Replaced" for one the vault already holds.
	// A rerun against a warm profile takes the second path, so accepting only the first would
	// fail the seeder on its own second run.
	const output = result.stdout.toString() + result.stderr.toString();
	if (!output.includes(`Stored ${name}`) && !output.includes(`Replaced ${name}`)) {
		throw new Error(`seeding ${name} failed:\n${output}`);
	}
}

// One per scope, with lifetimes that differ, so the EXPIRES column shows three different answers
// rather than one repeated word. `STRIPE_KEY` never expires, which is the case that has no number
// to print and is therefore the one most likely to be laid out wrongly.
await addSecret("GITHUB_TOKEN", "ghp_demoCredential0000000001", "profile", "7d");
await addSecret("DEPLOY_KEY", "dpl_demoCredential0000000002", "project", "2w");
await addSecret("STRIPE_KEY", "sk_live_demoCredential000003", "global", "never");
await addSecret("NPM_TOKEN", "npm_demoCredential000000004", "profile", "2h");

// Uses that disagree with each other on purpose: different tools, one record spending two
// credentials at once, commands both far shorter and far longer than the column can hold, and
// one credential (GITHUB_TOKEN) spent more than once so tracing it with `u` has something to
// narrow to. Timestamps are spread so the WHEN column is not a single repeated value.
const auditLog = new SecretAuditLog(secretAuditPath(locations));
const now = Date.now();

auditLog.record({
	at: now - 4 * 86_400_000,
	tool: "bash",
	command: "git push origin main",
	secrets: ["#GITHUB_TOKEN#"],
});
auditLog.record({
	at: now - 2 * 86_400_000,
	tool: "fetch",
	command: "curl -H 'Authorization: bearer #GITHUB_TOKEN#' https://api.github.com/user/repos?per_page=100",
	secrets: ["#GITHUB_TOKEN#"],
});
auditLog.record({
	at: now - 26 * 3_600_000,
	tool: "bash",
	command: "scp -i #DEPLOY_KEY# build.tar deploy@host:/srv/releases/",
	secrets: ["#DEPLOY_KEY#"],
});
auditLog.record({
	at: now - 5 * 3_600_000,
	tool: "fetch",
	command: "POST https://api.stripe.com/v1/charges with #STRIPE_KEY#",
	secrets: ["#STRIPE_KEY#"],
});
auditLog.record({
	at: now - 90 * 60_000,
	tool: "bash",
	command: "./scripts/release.sh --registry-token #NPM_TOKEN# --github-token #GITHUB_TOKEN# --tag v1.0.0",
	secrets: ["#NPM_TOKEN#", "#GITHUB_TOKEN#"],
});
auditLog.record({
	at: now - 3 * 60_000,
	tool: "bash",
	command: "npm whoami",
	secrets: ["#NPM_TOKEN#"],
});

await auditLog.flush();

process.stdout.write(`seeded 4 secrets and 6 uses for profile ${profile}\n`);
