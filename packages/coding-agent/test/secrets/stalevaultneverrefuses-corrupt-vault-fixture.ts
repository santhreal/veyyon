/**
 * Induce the ONE vault failure that `load()` is allowed to skip, for suites that need a scope to be
 * unreadable without the session refusing to start.
 *
 * WHY THIS IS NOT JUST WRITING GARBAGE. `load()` was narrowed deliberately: only
 * `UnparseableVaultPayloadError`, raised when a payload has already cleared every provenance and
 * integrity check and its DECRYPTED plaintext still will not parse, is skipped with a notice.
 * Everything else rethrows and still refuses to start, because catching wider turned each of the
 * vault's security refusals into "that scope has no secrets" and, through the obfuscator, into a
 * silent disclosure path.
 *
 * So writing invalid JSON to the vault path does NOT produce an unreadable scope any more; it
 * produces a hard refusal at startup, which is correct and is the security suite's contract to own.
 * Suites here previously borrowed that input and collided with it. This helper seals genuinely
 * non-JSON plaintext under the real key with the correct scope binding, so the file passes the pin,
 * ownership, mode and authentication checks and fails only at the parse.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type VaultLocations, type VaultScope, vaultPathFor } from "@veyyon/coding-agent/secrets/vault";
import { loadOrCreateVaultKey, sealVault } from "@veyyon/coding-agent/secrets/vault-crypto";

/** Plaintext that authenticates perfectly and is not JSON. */
const UNPARSEABLE_PLAINTEXT = "this decrypted cleanly and is not json {{{";

/** One entry as the vault file stores it. */
export interface ExternalVaultEntry {
	readonly name: string;
	readonly value: string;
	readonly expiresAt: number | null;
}

/**
 * Seal `plaintext` into one scope's vault file the way ANOTHER PROCESS would.
 *
 * Raw write on purpose, never `SecretVault.add`. A write made through the vault API is re-anchored
 * by `recordSelfWrittenVault` so it does NOT advance the revision, which is deliberate: a session
 * that treated its own `/secret add` as tampering could never spend the secret it just stored.
 * Since a test runs in one process, calling `add` to simulate a peer produces a change the loader
 * correctly considers its own, the revision never moves, and any guard keyed on staleness is never
 * reached. Writing the bytes directly is what makes the change external.
 *
 * The scope must already hold a real vault, so the binding sealed here is the one the loader will
 * compute. Returns the path written, for a suite that needs to name or repair it.
 */
export async function writeScopeExternally(
	locations: VaultLocations,
	scope: VaultScope,
	plaintext: string,
): Promise<string> {
	const vaultPath = vaultPathFor(locations, scope);
	const directory = path.dirname(vaultPath);
	// The binding covers the REAL directory identity, so resolve symlinks the same way the loader
	// does; sealing against the unresolved path would fail authentication instead of parsing.
	const directoryStat = await fs.lstat(directory);
	const canonicalVaultPath = path.join(await fs.realpath(directory), path.basename(vaultPath));
	const comparablePath = process.platform === "win32" ? canonicalVaultPath.toLowerCase() : canonicalVaultPath;
	const key = await loadOrCreateVaultKey(locations.globalConfigRoot);
	const binding = `${scope}\0${comparablePath}\0${directoryStat.dev}\0${directoryStat.ino}`;
	await fs.writeFile(vaultPath, JSON.stringify(sealVault(key, plaintext, binding)), { mode: 0o600 });
	return vaultPath;
}

/**
 * Replace one scope's vault with an authenticated file whose decrypted payload will not parse.
 *
 * The PERMANENT failure: every reload from here reaches the same wall, so a guard that retries
 * until the revision settles never terminates.
 */
export async function makeScopeUnreadable(locations: VaultLocations, scope: VaultScope): Promise<string> {
	return await writeScopeExternally(locations, scope, UNPARSEABLE_PLAINTEXT);
}

/**
 * Replace one scope's vault with a readable file holding `entries`, as an external writer would.
 *
 * The MOMENTARY change: the revision moves and the lease goes stale, but a reload reconciles it.
 * Differs from {@link makeScopeUnreadable} in exactly one variable, whether the payload parses.
 */
export async function writeScopeEntriesExternally(
	locations: VaultLocations,
	scope: VaultScope,
	entries: readonly ExternalVaultEntry[],
): Promise<string> {
	const now = Date.now();
	const payload = {
		entries: entries.map(entry => ({
			name: entry.name,
			value: entry.value,
			createdAt: now,
			expiresAt: entry.expiresAt,
		})),
	};
	return await writeScopeExternally(locations, scope, JSON.stringify(payload));
}
