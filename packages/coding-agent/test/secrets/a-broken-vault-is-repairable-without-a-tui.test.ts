/**
 * A vault that cannot be read must not lock the operator out of the command that repairs it.
 *
 * WHY THIS SUITE EXISTS. `/secret discard` is the in-product repair for a broken vault, and it was
 * reachable only from the full-screen interface. `load()` refuses every failure that is not an
 * already-authenticated unparseable payload, that throw escaped the secret-runtime build, and the
 * session died before a command could be dispatched. So a headless, scripted or ACP operator met a
 * vault they could not read, could not list, and could not repair. Worse, the error they were shown
 * RECOMMENDED `/secret discard`: `-p /secret list` and `-p /secret discard --scope project` both
 * exited 1 with the same message, one of them naming the command the other had just refused to run.
 *
 * THE FIX IS NOT A WIDER CATCH, and the row that proves it is `load() still refuses`. Skipping a
 * scope that failed a provenance or integrity check turns each of the vault's security refusals into
 * "that scope has no secrets", which drops a tampered scope's entries out of the obfuscator without
 * a word. `load()` therefore still throws exactly as it did; the failure is absorbed one level up,
 * where the answer is unambiguous, because the whole vault is gone rather than one scope quietly
 * reading empty.
 *
 * WHAT MAKES THAT SAFE is the unreadable-versus-empty distinction, which every row here leans on. A
 * scope marked unreadable makes the spend seam refuse its placeholders and the list say so; a scope
 * believed empty makes `#NAME#` resolve to nothing. The failure aborts the load before other scopes
 * are collected, so all of them are marked, not just the one that threw.
 *
 * The break modes are the ones an operator actually hits: a key restored without its vault, a key
 * rotated or regenerated on a new machine, and a truncated file. None of them is the unparseable
 * payload the sibling discard suite uses, on purpose: that one was already survivable, and a suite
 * that induced it here would exercise the branch that always worked and pass while this stayed broken.
 */
import { describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	parseSecretCommand,
	runSecretCommand,
	type SecretCommandSurface,
} from "@veyyon/coding-agent/secrets/secret-command";
import { SecretVault, type VaultLocations, type VaultScope, vaultPathFor } from "@veyyon/coding-agent/secrets/vault";
import { vaultKeyPath } from "@veyyon/coding-agent/secrets/vault-crypto";
import { makeScopeUnreadable } from "./stalevaultneverrefuses-corrupt-vault-fixture";

const NOW = 1_800_000_000_000;
const NAME = "PROJECT_TOKEN";
const VALUE = "ghp_a_real_looking_project_credential";

interface Fixture {
	readonly locations: VaultLocations;
	readonly vault: SecretVault;
	/** Run `/secret <args>` the way a non-interactive client does: its own parse, then dispatch. */
	secret(args: string, surface?: SecretCommandSurface): Promise<string>;
	movedAside(scope: VaultScope): Promise<string[]>;
}

async function fixture(): Promise<{ fx: Fixture; cleanup: () => Promise<void> }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-headless-repair-"));
	const globalConfigRoot = path.join(root, "config");
	const locations: VaultLocations = {
		globalConfigRoot,
		profileDir: path.join(globalConfigRoot, "profiles", "work", "agent"),
		projectDir: path.join(root, "project", ".veyyon"),
	};
	await fs.mkdir(globalConfigRoot, { recursive: true, mode: 0o700 });
	const vault = new SecretVault(locations, () => NOW);
	return {
		fx: {
			locations,
			vault,
			secret: async (args, surface: SecretCommandSurface = "noninteractive") => {
				const result = await runSecretCommand(parseSecretCommand(args, surface), {
					vault,
					readEnv: () => undefined,
					defaultTtl: null,
					now: NOW,
					surface,
				});
				return result.message;
			},
			movedAside: async scope => {
				const directory = path.dirname(vaultPathFor(locations, scope));
				const names = await fs.readdir(directory);
				return names.filter(name => name.includes(".unreadable-")).sort();
			},
		},
		cleanup: () => fs.rm(root, { recursive: true, force: true }),
	};
}

/** The three ways an operator actually arrives at a vault that will not open. */
const BREAKS: Record<string, (fx: Fixture) => Promise<void>> = {
	"the key was deleted": async fx => {
		await fs.rm(vaultKeyPath(fx.locations.globalConfigRoot));
	},
	"the key was replaced, as on a new machine": async fx => {
		await fs.writeFile(vaultKeyPath(fx.locations.globalConfigRoot), crypto.randomBytes(32), { mode: 0o600 });
	},
	"the vault file was truncated": async fx => {
		const target = vaultPathFor(fx.locations, "project");
		const text = await Bun.file(target).text();
		await Bun.write(target, text.slice(0, Math.floor(text.length / 2)));
	},
};

/** Store a real project secret, then break the vault the named way. */
async function broken(breakIt: (fx: Fixture) => Promise<void>): Promise<{ fx: Fixture; cleanup: () => Promise<void> }> {
	const made = await fixture();
	await made.fx.vault.add({ name: NAME, value: VALUE, scope: "project", ttl: null });
	await breakIt(made.fx);
	return made;
}

describe("a broken vault is repairable without a TUI", () => {
	for (const [label, breakIt] of Object.entries(BREAKS)) {
		/**
		 * THE ROW THAT DEFENDS THE SECURITY BOUNDARY. `load()` must keep throwing. If a later change
		 * makes the session start by widening its catch instead, this fails and says so, because a
		 * skipped scope is indistinguishable from an empty one to everything downstream.
		 */
		it(`still refuses to read the vault when ${label}`, async () => {
			const { fx, cleanup } = await broken(breakIt);
			try {
				await expect(fx.vault.load()).rejects.toThrow();
			} finally {
				await cleanup();
			}
		});

		/** The repair itself, driven the way a headless client reaches it rather than through a TUI. */
		it(`repairs the vault from a non-interactive surface when ${label}`, async () => {
			const { fx, cleanup } = await broken(breakIt);
			try {
				const message = await fx.secret("discard project");

				expect(message).toContain("Moved the unreadable project vault");
				expect(await fx.movedAside("project")).toHaveLength(1);
				// The point of the repair: the very next command works.
				await expect(fx.vault.load()).resolves.toEqual([]);
				await fx.vault.add({ name: NAME, value: VALUE, scope: "project", ttl: null });
				expect((await fx.vault.load()).map(entry => entry.name)).toEqual([NAME]);
			} finally {
				await cleanup();
			}
		});

		/**
		 * `/secret list` is where an operator goes to find out what is wrong, so it has to survive the
		 * thing that is wrong. It threw, which on `-p` meant a non-zero exit with nothing on stdout.
		 */
		it(`lists a diagnosis instead of throwing when ${label}`, async () => {
			const { fx, cleanup } = await broken(breakIt);
			try {
				const message = await fx.secret("list");

				expect(message).toContain("could not be read");
				expect(message).toContain("/secret discard project");
				// The falsehood this replaces. The credential is in a file three lines away.
				expect(message).not.toContain("No active secrets");
				expect(message).not.toContain(VALUE);
			} finally {
				await cleanup();
			}
		});
	}

	/**
	 * A scope with no vault file must not be named in the repair, because `/secret discard` on it
	 * fails: there is nothing to move aside. A message that recommends a command which then refuses is
	 * the exact defect this suite exists to remove, one level down.
	 */
	it("names only the scopes that have a file to move aside", async () => {
		const { fx, cleanup } = await broken(BREAKS["the key was deleted"]);
		try {
			const scopes = await fx.vault.noteFailedLoad(new Error("test"));

			expect(scopes).toEqual(["project"]);
			expect(scopes).not.toContain("global");
			expect(scopes).not.toContain("profile");
		} finally {
			await cleanup();
		}
	});

	/**
	 * THE DISCLOSURE ROW. A vault moved to a path its seal does not authenticate is the attack the
	 * narrow catch in `load()` exists to refuse: copied ciphertext must not read as that scope's
	 * contents, and must not read as an EMPTY scope either. Both would be silent; the second is the
	 * one that survives a careless fix, because "no secrets here" looks like a normal state.
	 */
	it("refuses a vault whose seal does not authenticate its location, rather than reading it empty", async () => {
		const { fx, cleanup } = await fixture();
		try {
			await fx.vault.add({ name: NAME, value: VALUE, scope: "project", ttl: null });
			const stolen = vaultPathFor(fx.locations, "global");
			await fs.mkdir(path.dirname(stolen), { recursive: true });
			await fs.copyFile(vaultPathFor(fx.locations, "project"), stolen);
			await fs.rm(vaultPathFor(fx.locations, "project"));

			await expect(fx.vault.load()).rejects.toThrow();
			const message = await fx.secret("list");
			expect(message).toContain("could not be read");
			expect(message).not.toContain("No active secrets");
			expect(message).not.toContain(NAME);
			expect(message).not.toContain(VALUE);
		} finally {
			await cleanup();
		}
	});

	/**
	 * A partially broken vault is the case that was silent in the other direction: `load()` already
	 * survived one unreadable scope, and the list said nothing about it, so a healthy scope's table
	 * was printed as if it were the whole answer.
	 *
	 * This needs the SURVIVABLE break, an authenticated payload whose plaintext will not parse, which
	 * is the only failure `load()` skips. Writing invalid outer JSON instead produces the hard class
	 * every other row here uses, which aborts the whole load and marks both scopes, so the profile
	 * entries would be gone and the row would be measuring the wrong branch.
	 */
	it("says a scope is missing from the list rather than printing a confident partial table", async () => {
		const { fx, cleanup } = await fixture();
		try {
			await fx.vault.add({ name: "PROFILE_TOKEN", value: VALUE, scope: "profile", ttl: null });
			await fx.vault.add({ name: NAME, value: VALUE, scope: "project", ttl: null });
			await makeScopeUnreadable(fx.locations, "project");

			const message = await fx.secret("list");

			expect(message).toContain("#PROFILE_TOKEN#");
			expect(message).toContain("could not be read");
			expect(message).toContain("/secret discard project");
			// The broken scope's own entry cannot appear: it was never decrypted.
			expect(message).not.toContain(`#${NAME}#`);
		} finally {
			await cleanup();
		}
	});
});
