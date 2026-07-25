/**
 * A user-facing "where do my credentials live" message must name the store that
 * is actually open, resolved through the ONE owner `getActiveAuthDbPath()`.
 *
 * WHY THIS SUITE EXISTS. Under profile sharing (the default), the credential
 * store the agent opens is the machine-wide `~/.veyyon/shared-auth/agent.db`,
 * while `getAgentDbPath()` computes this profile's OWN sibling `agent.db` — a
 * file that is empty precisely when sharing is on. The login and logout screens
 * interpolated `getAgentDbPath()` directly, so a user with working, shared
 * credentials was told they were saved to an empty file. That reads as
 * corruption, and it sent people through a pointless re-login.
 *
 * `getActiveAuthDbPath()` (utils/dirs.ts) exists as the single owner of that
 * decision and its doc comment says to use it for exactly these messages, yet
 * three call sites still bypassed it. A behavior test on one screen cannot catch
 * the others — both offenders here were TUI paint paths — so this is a
 * source-lock in the style the repo already uses (the atomic-write and
 * doubled-`Error:` locks): it scans every shipped `coding-agent` source, so a
 * new message naming a credential store cannot silently reintroduce the split.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));

/**
 * A user-facing sentence naming a credential store. These are the phrasings the
 * TUI and CLI actually print; each must interpolate the active-store resolver.
 */
const CREDENTIAL_PATH_MESSAGE = /(Credentials saved to|Credential removed from|credentials (?:are )?stored in)\s*\$\{/;

/** The bypass: naming the per-profile store instead of the active one. */
const NAMES_PROFILE_STORE = /\$\{getAgentDbPath\(\)\}/;

/**
 * `auth-broker-cli.ts` is exempt BY DESIGN, not by oversight: `runLocalLogin`
 * OPENS `getAgentDbPath()` and then names that same path, so the two agree. It
 * would become a lie, not a fix, if the message alone were switched to the
 * active store while the login still wrote to the per-profile one. That the
 * broker CLI writes to a store the agent may not read under sharing is a real
 * but separate defect, tracked in BACKLOG as AUTH-BROKER-CLI-STORE-SPLIT.
 */
const EXEMPT = new Set(["cli/auth-broker-cli.ts"]);

function collectSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...collectSourceFiles(full));
		else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
	}
	return out;
}

describe("user-facing credential-store messages name the active store", () => {
	it("names no per-profile agent.db in any credential-path message across coding-agent src", () => {
		const offenders: string[] = [];
		for (const file of collectSourceFiles(SRC_ROOT)) {
			const rel = file.slice(SRC_ROOT.length + 1);
			if (EXEMPT.has(rel)) continue;
			readFileSync(file, "utf8")
				.split("\n")
				.forEach((line, index) => {
					if (CREDENTIAL_PATH_MESSAGE.test(line) && NAMES_PROFILE_STORE.test(line)) {
						offenders.push(`${rel}:${index + 1}`);
					}
				});
		}
		expect(
			offenders,
			"these messages name the per-profile agent.db, which is EMPTY under profile sharing; " +
				"interpolate getActiveAuthDbPath() so the path matches the store that is actually open",
		).toEqual([]);
	});

	/**
	 * The positive half: the two screens that regressed must still resolve through
	 * the owner. Without this, deleting the messages entirely would pass the
	 * scan above and leave the user with no path at all.
	 */
	it("keeps the login and logout screens resolving through getActiveAuthDbPath", () => {
		for (const rel of [
			"modes/setup-wizard/scenes/sign-in.ts",
			"modes/controllers/selector-controller.ts",
		]) {
			const src = readFileSync(join(SRC_ROOT, rel), "utf8");
			expect(src, `${rel} must import the active-store resolver`).toContain("getActiveAuthDbPath");
			expect(src.match(/Credentials saved to \$\{getActiveAuthDbPath\(\)\}/)).not.toBeNull();
		}
	});
});
