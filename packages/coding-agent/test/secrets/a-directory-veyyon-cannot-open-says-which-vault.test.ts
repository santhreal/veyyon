/**
 * A scope directory or key directory veyyon cannot OPEN is described the same way as one it cannot
 * stat, and its path is terminal-escaped before it is quoted.
 *
 * WHAT WAS WRONG. `pinVaultScope` and `pinKeyRoot` both begin with an `lstat`, whose failures they
 * wrap into a sentence naming the scope, the path and the reason, with the path run through
 * `escapeTerminalText`. Immediately afterwards each opens the directory as a descriptor, and that
 * call had no catch at all, so the bare Node error escaped the whole subsystem:
 *
 *     Error: EACCES: permission denied, open '/home/me/.veyyon/profiles/work/agent'
 *
 * Measured before the fix, from `SecretVault.load()` over a mode-000 profile directory. Two things
 * are wrong with it. It never says the word vault, key or secret, so an operator whose session
 * refuses to start over a directory mode is handed a path and no subject: the reason it could not be
 * read reaches them through `noteFailedVaultLoad`, which quotes this string verbatim into an
 * operator notice. And the path is the one path in these two files that never passes through
 * `escapeTerminalText`, so a directory name carrying an ESC byte reaches the terminal raw, on the
 * exact surface every other refusal in these files escapes.
 *
 * These tests are the deterministic form of that window. The race the descriptor open really guards
 * (the directory removed between the stat and the open) cannot be scheduled from a test, but an
 * unreadable directory reaches the identical branch with no timing at all.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveVaultLocations, SecretVault, type VaultLocations } from "@veyyon/coding-agent/secrets/vault";
import { loadOrCreateVaultKey } from "@veyyon/coding-agent/secrets/vault-crypto";

/**
 * Mode 000 means nothing to uid 0, so these assertions describe a non-root process only.
 *
 * Skipped rather than adapted: there is no unprivileged-looking directory a root process cannot
 * open, so a root run has no way to reach the branch under test and a test that passes by not
 * exercising it would be worse than one that says it did not run.
 */
const asRoot = typeof process.geteuid === "function" && process.geteuid() === 0;
const unlessRoot = asRoot ? it.skip : it;

/** A throwaway tree whose profile scope directory is the one being made unreadable. */
async function withTree(
	body: (tree: { root: string; locations: VaultLocations; profileDir: string }) => Promise<void>,
	options?: { profileName?: string },
): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-unopenable-"));
	const profileDir = path.join(root, options?.profileName ?? "profile");
	try {
		await fs.mkdir(path.join(root, "config"), { mode: 0o700, recursive: true });
		await fs.mkdir(profileDir, { mode: 0o700, recursive: true });
		const locations = resolveVaultLocations({
			cwd: path.join(root, "project"),
			agentDir: profileDir,
			globalConfigRoot: path.join(root, "config"),
		});
		await body({ root, locations, profileDir });
	} finally {
		// Restore the mode first: `rm -r` cannot descend a directory it cannot open either.
		await fs.chmod(profileDir, 0o700).catch(() => {});
		await fs.rm(root, { recursive: true, force: true });
	}
}

describe("a vault scope directory that cannot be opened", () => {
	/**
	 * The load path. This is the string `noteFailedVaultLoad` quotes into the operator notice, so
	 * the assertion is on the whole sentence rather than on a substring: the defect was that the
	 * sentence had no subject, and a `toContain("vault")` would pass on any wording that mentions
	 * one anywhere.
	 */
	unlessRoot("names the scope, the path and the reason when load cannot open it", async () => {
		await withTree(async ({ locations, profileDir }) => {
			const vault = new SecretVault(locations);
			await vault.add({ name: "TOKEN", value: "ghp_unopenabledirvalue0123456789", scope: "profile" });
			await fs.chmod(profileDir, 0o000);

			const error = await vault.load().then(
				() => undefined,
				(caught: unknown) => caught,
			);

			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe(
				`The profile vault directory at ${profileDir} could not be opened safely ` +
					`(Error: EACCES: permission denied, open '${profileDir}').`,
			);
		});
	});

	/** The write path reaches the same pin, so it must not degrade to the bare Node error either. */
	unlessRoot("names the scope, the path and the reason when a write cannot open it", async () => {
		await withTree(async ({ locations, profileDir }) => {
			const vault = new SecretVault(locations);
			await vault.add({ name: "TOKEN", value: "ghp_unopenabledirvalue0123456789", scope: "profile" });
			await fs.chmod(profileDir, 0o000);

			const error = await vault
				.add({ name: "SECOND", value: "sk-unopenabledirsecond0123456", scope: "profile" })
				.then(
					() => undefined,
					(caught: unknown) => caught,
				);

			expect((error as Error).message).toBe(
				`The profile vault directory at ${profileDir} could not be opened safely ` +
					`(Error: EACCES: permission denied, open '${profileDir}').`,
			);
		});
	});

	/**
	 * The escaping, proved on the bytes rather than on the intent.
	 *
	 * A directory name is attacker-influenced wherever a project is: `resolveVaultLocations` builds
	 * the project scope from the working directory. The ESC is asserted ABSENT and its escape form
	 * asserted present, because a message that merely mentions the path would satisfy either.
	 */
	unlessRoot("escapes a control byte in the directory name instead of emitting it", async () => {
		await withTree(
			async ({ locations, profileDir }) => {
				const vault = new SecretVault(locations);
				await vault.add({ name: "TOKEN", value: "ghp_unopenabledirvalue0123456789", scope: "profile" });
				await fs.chmod(profileDir, 0o000);

				const error = await vault.load().then(
					() => undefined,
					(caught: unknown) => caught,
				);
				const message = (error as Error).message;

				expect(message).not.toContain("\u001b");
				expect(message).toContain("prof\\u001B[31mile");
			},
			{ profileName: "prof\u001b[31mile" },
		);
	});
});

describe("a vault key directory that cannot be opened", () => {
	/**
	 * `pinKeyRoot` guards every read and create path for the key, and its descriptor open had the
	 * same missing catch as the vault's.
	 *
	 * MODE 0o100, NOT 0o000. Traverse-only is the mode that isolates this branch: the key file is
	 * still reachable through the directory, so `hardenEmptyKeyRoot`'s own lstat succeeds and returns
	 * early, and the first thing to fail is the `O_DIRECTORY` open that needs the read bit. Mode 000
	 * fails earlier, in `hardenEmptyKeyRoot`, whose message at least names `vault.key`.
	 */
	unlessRoot("names the key directory, the path and the reason", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-unopenable-key-"));
		const configRoot = path.join(root, "config");
		try {
			await fs.mkdir(configRoot, { mode: 0o700 });
			await loadOrCreateVaultKey(configRoot);
			await fs.chmod(configRoot, 0o100);

			const error = await loadOrCreateVaultKey(configRoot).then(
				() => undefined,
				(caught: unknown) => caught,
			);

			// `publicKeyError` already escapes and redacts this message at the outer boundary, so the
			// assertion is on the finished operator-visible string.
			expect((error as Error).message).toBe(
				`The vault key directory at ${configRoot} could not be opened safely ` +
					`(Error: EACCES: permission denied, open '${configRoot}').`,
			);
		} finally {
			await fs.chmod(configRoot, 0o700).catch(() => {});
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
