/**
 * `/secret clear everywhere` empties all three vaults in one command, names what it removed, and
 * tells the model every placeholder it must stop writing.
 *
 * WHY THIS SUITE EXISTS. `clear` requires a vault word and empties exactly one file. Getting back to
 * no stored credentials therefore took three commands, and taking them required knowing in advance
 * that there were three places to look: nothing on the surface said so, and `/secret list` shows the
 * resolved view, in which a project copy hides the profile one. "Remove everything" is the request
 * an operator makes when a machine is shared, handed on, or compromised, and it was the one request
 * the grammar could not take.
 *
 * THE CLASS. A destructive command that acts on one member of a closed set needs a way to name the
 * whole set, and the report has to account for every member -- including the ones that were already
 * empty, because "did that get everything" is the question the operator asked. A command that
 * cleared two of three and mentioned only what it found would leave a live credential behind a
 * confident message.
 *
 * WHAT IS PINNED:
 *   1. Every spelling of "all of them" reaches the same operation, read from `EVERY_VAULT_WORDS` at
 *      run time so a word added to that list is covered without anyone remembering to.
 *   2. The word is reserved for `clear` alone. On any other scope-taking command it is refused,
 *      because there is no such destination and no such file.
 *   3. Every scope is cleared and every scope is named, empty ones included.
 *   4. Every removed name is revoked to the model, and a shadowed copy cannot survive: after this
 *      command there is no vault left for one to hide in.
 *   5. The vaults are really empty afterwards, read back through a fresh load.
 *
 * WHAT IT DOES NOT CATCH: the branch that reports a survivor. It fires when a scope is written back
 * during the command or cannot be read at all, which needs a concurrent writer this suite does not
 * run. The report is asserted to be silent about survivors when there are none, so the branch cannot
 * fire spuriously.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	EVERY_VAULT_WORDS,
	parseSecretCommand,
	runSecretCommand,
	SECRET_SUBCOMMAND_SHAPES,
	type SecretCommandRequest,
	type SecretSubcommand,
} from "@veyyon/coding-agent/secrets/secret-command";
import { resolveVaultLocations, SecretVault, VAULT_SCOPES, type VaultScope } from "@veyyon/coding-agent/secrets/vault";

const NOW = 1_700_000_000_000;

/** One credential per scope, shaped like the real thing so a leak of any of them is unmistakable. */
const VALUES: Record<VaultScope, string> = {
	global: "ghp_global_scope_credential_1",
	profile: "sk-live-profile-credential-2",
	project: "xoxb-project-credential-0003",
};

/** A vault over three temporary scope files, plus the names stored in each. */
async function seededVault(scopes: readonly VaultScope[]): Promise<{ vault: SecretVault; dir: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-clear-all-"));
	const vault = new SecretVault(
		resolveVaultLocations({
			globalConfigRoot: path.join(dir, "global"),
			agentDir: path.join(dir, "profile"),
			cwd: dir,
		}),
	);
	for (const scope of scopes) {
		await vault.add({ name: `${scope.toUpperCase()}_TOKEN`, value: VALUES[scope], scope, ttl: null });
	}
	return { vault, dir };
}

function clearEverywhere(vault: SecretVault) {
	return runSecretCommand(
		{ subcommand: "clear", allScopes: true },
		{ vault, readEnv: () => undefined, defaultTtl: null, now: NOW },
	);
}

describe("the grammar reads every spelling of all vaults", () => {
	/** Fail by default: a word added to the list is exercised here without a new case. */
	it("routes each word to the same operation", () => {
		for (const word of EVERY_VAULT_WORDS) {
			const request = parseSecretCommand(`clear ${word}`, "noninteractive");

			expect(request.allScopes).toBe(true);
			// No single vault is named, so nothing downstream can act on one by accident.
			expect(request.scope).toBeUndefined();
		}
	});

	/**
	 * The word belongs to `clear` and to nothing else.
	 *
	 * Swept over every command that reads a vault, positionally or trailing, rather than the two that
	 * exist today, so a fourth scope-taking command cannot quietly inherit a word it has no meaning
	 * for. The two shapes refuse it with different sentences -- a positional vault says which three
	 * words it wanted, a trailing one says the word fits no slot -- so what is pinned is the part
	 * that matters on both: the request is refused, `allScopes` is never set, and the refusal does
	 * not advertise a form the command cannot honour.
	 */
	it("refuses the word on every other command that takes a vault", () => {
		const others = (Object.keys(SECRET_SUBCOMMAND_SHAPES) as SecretSubcommand[]).filter(
			command =>
				command !== "clear" &&
				(SECRET_SUBCOMMAND_SHAPES[command].slots.includes("scope") ||
					SECRET_SUBCOMMAND_SHAPES[command].trailing.includes("scope")),
		);

		expect(others.length).toBeGreaterThan(0);
		for (const command of others) {
			const shape = SECRET_SUBCOMMAND_SHAPES[command];
			const positional = shape.slots.includes("scope");
			const words = shape.slots.map(slot => (slot === "scope" ? "everywhere" : "TOKEN_A"));
			const line = [command, ...words, ...(positional ? [] : ["everywhere"])].join(" ");

			let accepted: SecretCommandRequest | undefined;
			let message = "";
			try {
				accepted = parseSecretCommand(line, "noninteractive");
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}

			expect(accepted, `${line} was accepted`).toBeUndefined();
			expect(message).not.toContain("everywhere for all three");
			if (positional) expect(message).toMatch(/Write profile, project or global/);
		}
	});

	/** A bare `clear` still refuses, and the refusal now says the all-three form exists. */
	it("still refuses a clear with no vault, and offers the new form", () => {
		expect(() => parseSecretCommand("clear", "noninteractive")).toThrow(/clear everywhere/);
	});
});

describe("clearing every vault removes every stored credential", () => {
	it("empties all three and names each one", async () => {
		const { vault, dir } = await seededVault(VAULT_SCOPES);
		try {
			const result = await clearEverywhere(vault);

			expect(result.changed).toBe(true);
			expect(result.message).toContain("Removed 3 secrets from every vault.");
			for (const scope of VAULT_SCOPES) {
				expect(result.message).toContain(`${scope}: ${scope.toUpperCase()}_TOKEN.`);
				expect(result.message).not.toContain(VALUES[scope]);
			}
			// Nothing survived, so the report must not claim anything did.
			expect(result.message).not.toContain("still spendable");
			// Read back through a fresh load: the files, not the return value, are the contract.
			expect(
				await new SecretVault(
					resolveVaultLocations({
						globalConfigRoot: path.join(dir, "global"),
						agentDir: path.join(dir, "profile"),
						cwd: dir,
					}),
				).loadEverywhere(),
			).toEqual([]);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	/**
	 * An empty scope is named too.
	 *
	 * The operator's question is "is anything left anywhere", and a report that lists only the scopes
	 * it found something in answers a narrower question than the one asked.
	 */
	it("names a scope that held nothing", async () => {
		const { vault, dir } = await seededVault(["project"]);
		try {
			const result = await clearEverywhere(vault);

			expect(result.message).toContain("Removed 1 secret from every vault.");
			expect(result.message).toContain("global: nothing stored.");
			expect(result.message).toContain("profile: nothing stored.");
			expect(result.message).toContain("project: PROJECT_TOKEN.");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	/**
	 * Every removed name is revoked, and a name held in two scopes is revoked once.
	 *
	 * Clearing ONE scope has to distinguish a revoked name from a shadowing copy that still spends a
	 * different credential. Clearing all of them cannot: there is no vault left to hide a copy in, so
	 * every name is dead and the notice says so about all of them.
	 */
	it("tells the model every placeholder is dead", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-clear-all-shadow-"));
		try {
			const vault = new SecretVault(
				resolveVaultLocations({
					globalConfigRoot: path.join(dir, "global"),
					agentDir: path.join(dir, "profile"),
					cwd: dir,
				}),
			);
			// The same name in two scopes: the project copy is what `load` resolves, the global copy is
			// the one a single-scope clear would have left behind.
			await vault.add({ name: "SHARED_TOKEN", value: VALUES.project, scope: "project", ttl: null });
			await vault.add({ name: "SHARED_TOKEN", value: VALUES.global, scope: "global", ttl: null });

			const result = await clearEverywhere(vault);

			expect(result.agentNoticeIsRevocation).toBe(true);
			expect(result.agentNotice).toContain("#SHARED_TOKEN#");
			expect(result.agentNotice).toContain("every secret vault");
			expect(result.agentNotice).toContain("stop using");
			// No value, and no prefix of one, in a string that goes into the conversation.
			expect(result.agentNotice).not.toContain(VALUES.project);
			expect(result.agentNotice).not.toContain(VALUES.global.slice(0, 12));
			// Neither copy is left to become live again.
			expect(await vault.loadEverywhere()).toEqual([]);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	/** Nothing stored anywhere: no revocation, no change, and a sentence that says all three are empty. */
	it("says so when there was nothing to remove", async () => {
		const { vault, dir } = await seededVault([]);
		try {
			const result = await clearEverywhere(vault);

			expect(result.changed).toBe(false);
			expect(result.agentNotice).toBeUndefined();
			expect(result.message).toContain("No vault holds a secret");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	/**
	 * Clearing one vault still clears only that one.
	 *
	 * The new path must not have widened the old command: `clear profile` leaving a project
	 * credential in place is the behaviour every other case in this file depends on.
	 */
	it("leaves the other vaults alone when one is named", async () => {
		const { vault, dir } = await seededVault(VAULT_SCOPES);
		try {
			const result = await runSecretCommand(
				{ subcommand: "clear", scope: "profile" },
				{ vault, readEnv: () => undefined, defaultTtl: null, now: NOW },
			);

			expect(result.message).toContain("Removed 1 secret from the profile vault: PROFILE_TOKEN.");
			expect((await vault.loadEverywhere()).map(entry => entry.scope).sort()).toEqual(["global", "project"]);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
