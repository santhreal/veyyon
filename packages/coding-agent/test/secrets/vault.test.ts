/**
 * Vault semantics: names, lifetimes, scope precedence, and what expiry actually does.
 *
 * WHY THIS SUITE EXISTS. Two of these rules are dangerous if implemented the obvious way,
 * and they are the reason most of the assertions below exist.
 *
 *   1. EXPIRY MUST DELETE, NOT UNPROTECT. The naive reading of "the secret expired" is "stop
 *      obfuscating it", which would send the value to the model provider in plain text at the
 *      exact moment its protection lapsed. The feature's failure mode would be the harm it
 *      exists to prevent. So expiry removes the value from disk, and these tests assert the
 *      bytes are gone rather than merely filtered from a list.
 *   2. `never` MUST NOT BE A BIG NUMBER. Representing "never expires" as a far-future
 *      timestamp invites arithmetic that forgets to check, and a secret that quietly dies in
 *      the year 10000 is a bug nobody finds. It is `null`, and that is asserted.
 *
 * Time is injected everywhere, so expiry is tested by moving the clock rather than by
 * sleeping, and the tests stay deterministic.
 */
import { describe, expect, it, spyOn } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	DEFAULT_TTL_MS,
	describeTimeLeft,
	formatTtl,
	generateSecretName,
	isExpired,
	MAX_VAULT_FILE_BYTES,
	lifeFraction,
	normaliseSecretName,
	parseTtl,
	SecretVault,
	type VaultLocations,
	VAULT_FILENAME,
	vaultPathFor,
	warningThresholdCrossed,
} from "@veyyon/coding-agent/secrets/vault";
import { loadOrCreateVaultKey, sealVault, type SealedVault } from "@veyyon/coding-agent/secrets/vault-crypto";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** A long-enough value, since anything under the floor is refused by design. */
const VALUE = "ghp_a_real_looking_token";

/**
 * Whether a path exists, as a boolean.
 *
 * `fs.access` resolves with `undefined` on Node and `null` on Bun, so asserting on its
 * resolved value pins a runtime detail rather than the thing under test.
 */
async function exists(target: string): Promise<boolean> {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}

/** Construct the exact unbound envelope emitted before location-bound version 2. */
function sealLegacyVault(key: Buffer, plaintext: string): SealedVault {
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	return {
		v: 1,
		iv: iv.toString("base64"),
		tag: cipher.getAuthTag().toString("base64"),
		ct: ciphertext.toString("base64"),
	};
}

/** A vault over a throwaway tree, with a clock the test controls. */
async function withVault(
	body: (vault: SecretVault, locations: VaultLocations, clock: { now: number }) => Promise<void>,
): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-vault-"));
	try {
		const locations: VaultLocations = {
			globalConfigRoot: path.join(root, "config"),
			profileDir: path.join(root, "config", "profiles", "work", "agent"),
			projectDir: path.join(root, "project", ".veyyon"),
		};
		await fs.mkdir(locations.globalConfigRoot, { mode: 0o700 });
		const clock = { now: 1_800_000_000_000 };
		await body(new SecretVault(locations, () => clock.now), locations, clock);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

describe("lifetimes", () => {
	/** The units people actually type, each proved rather than assumed. */
	it("parses every supported unit", () => {
		expect(parseTtl("30m")).toBe(30 * 60 * 1000);
		expect(parseTtl("12h")).toBe(12 * HOUR);
		expect(parseTtl("7d")).toBe(7 * DAY);
		expect(parseTtl("2w")).toBe(14 * DAY);
	});

	/** `never` is the user's word for it, and it maps to null rather than to a large number. */
	it("maps never to null", () => {
		expect(parseTtl("never")).toBeNull();
		expect(parseTtl("NEVER")).toBeNull();
		expect(parseTtl("  never  ")).toBeNull();
	});

	/** Case and surrounding space are forgiven, because people type both. */
	it("accepts mixed case and padding", () => {
		expect(parseTtl(" 7D ")).toBe(7 * DAY);
	});

	/**
	 * A malformed lifetime throws instead of defaulting.
	 *
	 * The important one. If `7dd` silently became the one-day default, a credential would
	 * outlive the window its owner believed they chose, and nothing would ever say so.
	 */
	it("refuses a lifetime it cannot parse", () => {
		for (const bad of ["7dd", "d7", "7", "", "forever", "1y", "-3d", "3.5d"]) {
			expect(() => parseTtl(bad)).toThrow(/is not a lifetime/);
		}
	});

	/** Zero would expire on arrival, which is never what someone means. */
	it("refuses a zero lifetime", () => {
		expect(() => parseTtl("0d")).toThrow(/would expire immediately/);
	});

	/**
	 * Decimal input can overflow Number before multiplication by the unit.
	 *
	 * JSON would serialise an infinite expiry as null, silently turning a bounded credential
	 * into one that never expires. Both the parser and formatter reject that representation.
	 */
	it("refuses an overflowing lifetime instead of turning it into never", () => {
		expect(() => parseTtl(`${"9".repeat(309)}w`)).toThrow(/too large to represent safely/);
		expect(() => formatTtl(Number.POSITIVE_INFINITY)).toThrow(/finite.*safely representable/);
	});

	/**
	 * Formatting round-trips for the units it emits, so `list` shows what you typed.
	 *
	 * Days, hours and minutes round-trip exactly. Weeks deliberately do NOT: `w` is input
	 * sugar and output is in days. The formatter used to prefer the largest unit that divided
	 * evenly, which meant a secret created with `7d` was listed as `1w`, a unit the user never
	 * chose. Showing a lifetime back in different words than it was set in is how someone
	 * misreads how long they have.
	 */
	it("round-trips the units it emits", () => {
		for (const spec of ["30m", "12h", "7d", "14d", "90d", "never"]) {
			expect(formatTtl(parseTtl(spec))).toBe(spec);
		}
	});

	/** Weeks are accepted and then reported in days, which is the documented behaviour. */
	it("reports a lifetime given in weeks as days", () => {
		expect(formatTtl(parseTtl("2w"))).toBe("14d");
		expect(formatTtl(parseTtl("1w"))).toBe("7d");
	});

	/** The documented default is one day. */
	it("defaults to one day", () => {
		expect(DEFAULT_TTL_MS).toBe(DAY);
		expect(formatTtl(DEFAULT_TTL_MS)).toBe("1d");
	});
});

describe("expiry arithmetic", () => {
	const entry = { name: "T", value: VALUE, createdAt: 1000, expiresAt: 1000 + DAY };

	/** Not expired before the moment, expired at it and after. The boundary is inclusive. */
	it("expires at the boundary, not after a grace period", () => {
		expect(isExpired(entry, 1000)).toBe(false);
		expect(isExpired(entry, 1000 + DAY - 1)).toBe(false);
		expect(isExpired(entry, 1000 + DAY)).toBe(true);
		expect(isExpired(entry, 1000 + DAY + 1)).toBe(true);
	});

	/** A secret with no expiry never expires, however far the clock is pushed. */
	it("never expires a null expiry", () => {
		const forever = { ...entry, expiresAt: null };

		expect(isExpired(forever, Number.MAX_SAFE_INTEGER)).toBe(false);
		expect(lifeFraction(forever, 5000)).toBeNull();
		expect(warningThresholdCrossed(forever, Number.MAX_SAFE_INTEGER)).toBeNull();
	});

	/**
	 * Warnings are fractions of the lifetime, not absolute times.
	 *
	 * One rule for every lifetime. "24 hours left" is useless for a one-day secret and far too
	 * late for a 90-day one, so the thresholds scale with the window the user chose.
	 */
	it("warns at half life and at ninety percent", () => {
		expect(warningThresholdCrossed(entry, 1000)).toBeNull();
		expect(warningThresholdCrossed(entry, 1000 + DAY * 0.49)).toBeNull();
		expect(warningThresholdCrossed(entry, 1000 + DAY * 0.5)).toBe(0.5);
		expect(warningThresholdCrossed(entry, 1000 + DAY * 0.89)).toBe(0.5);
		expect(warningThresholdCrossed(entry, 1000 + DAY * 0.9)).toBe(0.9);
		expect(warningThresholdCrossed(entry, 1000 + DAY)).toBe(0.9);
	});

	/** The same thresholds work for a long lifetime, which is the point of using fractions. */
	it("uses the same thresholds for a ninety day secret", () => {
		const long = { ...entry, expiresAt: 1000 + 90 * DAY };

		expect(warningThresholdCrossed(long, 1000 + 44 * DAY)).toBeNull();
		expect(warningThresholdCrossed(long, 1000 + 45 * DAY)).toBe(0.5);
		expect(warningThresholdCrossed(long, 1000 + 81 * DAY)).toBe(0.9);
	});

	/** The phrase shown to the operator is readable at every scale. */
	it("describes the time left in the largest sensible unit", () => {
		expect(describeTimeLeft(entry, 1000)).toBe("1d left");
		expect(describeTimeLeft(entry, 1000 + 18 * HOUR)).toBe("6h left");
		expect(describeTimeLeft(entry, 1000 + DAY - 30 * 60 * 1000)).toBe("30m left");
		expect(describeTimeLeft(entry, 1000 + DAY)).toBe("expired");
		expect(describeTimeLeft({ ...entry, expiresAt: null }, 1000)).toBe("never expires");
	});
});

describe("names", () => {
	/** The shapes people type are normalised rather than refused on a technicality. */
	it("normalises what a user is likely to type", () => {
		expect(normaliseSecretName("github-token")).toBe("GITHUB_TOKEN");
		expect(normaliseSecretName("github token")).toBe("GITHUB_TOKEN");
		expect(normaliseSecretName("  deploy_key  ")).toBe("DEPLOY_KEY");
		expect(normaliseSecretName("AWS_SECRET_ACCESS_KEY")).toBe("AWS_SECRET_ACCESS_KEY");
	});

	/**
	 * A name that could be confused with an index placeholder is refused.
	 *
	 * `#ABCD#` is what an unnamed secret's placeholder looks like, so a four-character name
	 * would give the model one token meaning two credentials. The rule is derived from the
	 * index width rather than hardcoded, and `placeholder.test.ts` pins that coupling.
	 */
	it("refuses a name short enough to look like an index placeholder", () => {
		expect(() => normaliseSecretName("ABCD")).toThrow(/not a usable secret name/);
		expect(() => normaliseSecretName("A1B2")).toThrow(/not a usable secret name/);
		// Five characters is fine, because an index body is four.
		expect(normaliseSecretName("ABCDE")).toBe("ABCDE");
	});

	/** Characters that would be ambiguous inside `#...#` or in a shell are refused. */
	it("refuses characters that would be ambiguous in a placeholder", () => {
		for (const bad of ["my-token!", "tok#en", "a b#c", "1TOKEN", "_TOKEN", "TOK.EN", "TOK/EN"]) {
			expect(() => normaliseSecretName(bad)).toThrow(/not a usable secret name/);
		}
	});

	/** Unicode case expansion must not alias a rejected spelling onto an existing ASCII name. */
	it("rejects non-ASCII names before uppercase normalization", () => {
		for (const bad of ["ſECRET_TOKEN", "STRAẞE_TOKEN", "KELVİΝ_TOKEN"]) {
			expect(() => normaliseSecretName(bad)).toThrow(/not a usable secret name/);
		}
	});

	/** A name too long to read inline is refused, with the limit in the message. */
	it("refuses an over-long name", () => {
		expect(() => normaliseSecretName("A".repeat(65))).toThrow(/5 to 64 characters/);
	});

	/** Generated names avoid collisions, so an unnamed add never overwrites another secret. */
	it("generates a name that is not taken", () => {
		expect(generateSecretName(new Set())).toBe("SECRET_1");
		expect(generateSecretName(new Set(["SECRET_1"]))).toBe("SECRET_2");
		expect(generateSecretName(new Set(["SECRET_1", "SECRET_2", "SECRET_3"]))).toBe("SECRET_4");
	});

	/** Every generated name is itself valid, or the vault could store an unusable entry. */
	it("generates names that pass validation", () => {
		expect(normaliseSecretName(generateSecretName(new Set()))).toBe("SECRET_1");
	});
});

describe("storing and reading", () => {
	/** The ordinary case, and proof the value survives a full seal and open cycle. */
	it("stores a secret and reads it back", async () => {
		await withVault(async vault => {
			const added = await vault.add({ name: "github-token", value: VALUE });

			expect(added.name).toBe("GITHUB_TOKEN");
			expect(added.scope).toBe("profile");

			const loaded = await vault.load();
			expect(loaded).toHaveLength(1);
			expect(loaded[0]).toMatchObject({ name: "GITHUB_TOKEN", value: VALUE, scope: "profile" });
		});
	});

	/**
	 * Nothing readable is written to disk.
	 *
	 * The claim the whole feature rests on, asserted against the actual file rather than
	 * against the API. If someone replaces the seal with a plain write, every other test here
	 * still passes and this one fails.
	 */
	it("writes no plaintext to the vault file", async () => {
		await withVault(async (vault, locations) => {
			await vault.add({ name: "github-token", value: VALUE });

			const onDisk = await fs.readFile(vaultPathFor(locations, "profile"), "utf8");
			expect(onDisk).not.toContain(VALUE);
			expect(onDisk).not.toContain("GITHUB_TOKEN");
		});
	});

	/**
	 * Version 1 vaults have authenticated ciphertext but no authenticated provenance.
	 *
	 * A regular byte copy defeats symlink and hard-link checks, so silently accepting or
	 * migrating it would let the copy's destination relabel its scope. The only safe implicit
	 * behavior is to refuse and tell the operator to re-add it deliberately.
	 */
	it("rejects a legacy v1 vault because its scope provenance is unknowable", async () => {
		await withVault(async (vault, locations, clock) => {
			const key = await loadOrCreateVaultKey(locations.globalConfigRoot);
			const profileVault = vaultPathFor(locations, "profile");
			const projectVault = vaultPathFor(locations, "project");
			const legacyEntry = {
				name: "LEGACY_TOKEN",
				value: VALUE,
				createdAt: clock.now,
				expiresAt: clock.now + DAY,
			};
			await fs.mkdir(locations.profileDir, { recursive: true });
			await fs.writeFile(
				profileVault,
				JSON.stringify(sealLegacyVault(key, JSON.stringify({ entries: [legacyEntry] }))),
				{ mode: 0o600 },
			);

			// A byte copy has its own inode and link count, so path alias checks
			// cannot recover the original scope that v1 failed to authenticate.
			await fs.mkdir(locations.projectDir, { recursive: true });
			await fs.copyFile(profileVault, projectVault);
			await fs.rm(profileVault);

			await expect(vault.load()).rejects.toThrow(
				/project vault .* legacy format version 1.*no authenticated scope.*re-add.*intended scope/i,
			);
		});
	});

	it("accepts an outer vault file exactly at the byte limit", async () => {
		await withVault(async (vault, locations) => {
			await loadOrCreateVaultKey(locations.globalConfigRoot);
			const vaultPath = vaultPathFor(locations, "profile");
			const envelope = JSON.stringify({ v: 2, iv: "", tag: "", ct: "" });
			const text = envelope + " ".repeat(MAX_VAULT_FILE_BYTES - Buffer.byteLength(envelope));
			await fs.mkdir(locations.profileDir, { recursive: true });
			await fs.writeFile(vaultPath, text, { mode: 0o600 });

			// Reaching envelope validation proves the exact boundary was read and
			// parsed rather than rejected by an off-by-one size check.
			await expect(vault.load()).rejects.toThrow(/nonce is 0 bytes, expected 12/);
		});
	});

	it("rejects an oversized regular vault before parsing it", async () => {
		await withVault(async (vault, locations) => {
			const vaultPath = vaultPathFor(locations, "profile");
			await fs.mkdir(locations.profileDir, { recursive: true });
			await fs.writeFile(vaultPath, "x".repeat(MAX_VAULT_FILE_BYTES + 1), { mode: 0o600 });

			await expect(vault.load()).rejects.toThrow(
				new RegExp(`${MAX_VAULT_FILE_BYTES + 1} bytes.*${MAX_VAULT_FILE_BYTES}-byte safety limit`),
			);
		});
	});

	it("rejects an oversized sparse vault from descriptor size alone", async () => {
		await withVault(async (vault, locations) => {
			const vaultPath = vaultPathFor(locations, "profile");
			await fs.mkdir(locations.profileDir, { recursive: true });
			await fs.writeFile(vaultPath, "{", { mode: 0o600 });
			await fs.truncate(vaultPath, MAX_VAULT_FILE_BYTES + 1);

			await expect(vault.load()).rejects.toThrow(/over the 8388608-byte safety limit/);
		});
	});

	it("does not replace a readable vault with an envelope over the limit", async () => {
		await withVault(async vault => {
			await vault.add({ name: "SMALL_TOKEN", value: VALUE });

			await expect(
				vault.add({ name: "OVERSIZED_TOKEN", value: "x".repeat(MAX_VAULT_FILE_BYTES) }),
			).rejects.toThrow(/over the 6291402-byte plaintext safety limit/);
			expect((await vault.load()).map(entry => entry.name)).toEqual(["SMALL_TOKEN"]);
		});
	});

	/**
	 * The default scope is the profile, which is the boundary people actually want.
	 *
	 * Asserted by which FILES exist, not by the returned entry, because the scope claim is
	 * about where bytes land: a project-scoped write into a repository would be the one that
	 * gets committed by accident.
	 */
	it("defaults to profile scope", async () => {
		await withVault(async (vault, locations) => {
			await vault.add({ value: VALUE });

			expect(await exists(vaultPathFor(locations, "profile"))).toBe(true);
			expect(await exists(vaultPathFor(locations, "project"))).toBe(false);
			expect(await exists(vaultPathFor(locations, "global"))).toBe(false);
		});
	});

	/** An unnamed add still gets a name, so the model always has something to reference. */
	it("invents a name when none is given", async () => {
		await withVault(async vault => {
			const first = await vault.add({ value: VALUE });
			const second = await vault.add({ value: `${VALUE}_two` });

			expect(first.name).toBe("SECRET_1");
			expect(second.name).toBe("SECRET_2");
		});
	});

	/** The default lifetime is applied when none is given. */
	it("applies the one day default lifetime", async () => {
		await withVault(async (vault, _locations, clock) => {
			const added = await vault.add({ value: VALUE });

			expect(added.expiresAt).toBe(clock.now + DAY);
		});
	});

	/** An explicit `never` stores null rather than a distant timestamp. */
	it("stores never as null", async () => {
		await withVault(async vault => {
			const added = await vault.add({ value: VALUE, ttl: null });

			expect(added.expiresAt).toBeNull();
		});
	});

	/**
	 * Programmatic callers cannot bypass the parser with NaN, infinity, fractions, or a TTL
	 * whose resulting epoch would exceed Number's safe integer range.
	 */
	it("refuses non-finite and unsafe numeric lifetimes before writing", async () => {
		await withVault(async (vault, locations) => {
			for (const ttl of [
				Number.NaN,
				Number.POSITIVE_INFINITY,
				Number.NEGATIVE_INFINITY,
				1.5,
				Number.MAX_SAFE_INTEGER,
			]) {
				await expect(vault.add({ name: "BAD_TTL", value: VALUE, ttl })).rejects.toThrow(
					/finite.*safely representable|too large/,
				);
			}
			expect(await exists(vaultPathFor(locations, "profile"))).toBe(false);
		});
	});

	/** Re-adding the same name replaces it rather than accumulating duplicates. */
	it("replaces an entry of the same name in the same scope", async () => {
		await withVault(async vault => {
			await vault.add({ name: "TOKEN_A", value: VALUE });
			await vault.add({ name: "TOKEN_A", value: `${VALUE}_updated` });

			const loaded = await vault.load();
			expect(loaded).toHaveLength(1);
			expect(loaded[0].value).toBe(`${VALUE}_updated`);
		});
	});

	/** Replacements use a new synced inode rather than truncating the live vault in place. */
	it("replaces an existing vault atomically with an owner-only file", async () => {
		if (process.platform === "win32") return;
		await withVault(async (vault, locations) => {
			const vaultPath = vaultPathFor(locations, "profile");
			await vault.add({ name: "TOKEN_A", value: VALUE });
			const before = await fs.stat(vaultPath);

			await vault.add({ name: "TOKEN_B", value: `${VALUE}_b` });
			const after = await fs.stat(vaultPath);

			expect(after.ino).not.toBe(before.ino);
			expect(after.mode & 0o777).toBe(0o600);
		});
	});

	/** Existing vaults with broader POSIX access are refused before ciphertext is consumed. */
	it("refuses a vault file accessible by other users", async () => {
		if (process.platform === "win32") return;
		await withVault(async (vault, locations) => {
			const vaultPath = vaultPathFor(locations, "profile");
			await vault.add({ name: "PRIVATE_TOKEN", value: VALUE });
			const before = await fs.readFile(vaultPath);
			await fs.chmod(vaultPath, 0o644);

			await expect(vault.load()).rejects.toThrow(/accessible by other users/);
			expect(await fs.readFile(vaultPath)).toEqual(before);
		});
	});

	/** Descriptor-relative writes cannot be redirected by replacing the lexical scope directory. */
	it("fails closed when the scope parent is replaced during a mutation", async () => {
		if (process.platform === "win32") return;
		await withVault(async (vault, locations) => {
			await vault.add({ name: "TOKEN_A", value: VALUE });
			const displaced = `${locations.profileDir}.displaced`;
			const sentinel = path.join(locations.profileDir, "sentinel");
			const realOpen = fs.open;
			let replaced = false;
			const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
				const handle = await Reflect.apply(realOpen, fs, args);
				if (!replaced && String(args[0]).endsWith(".tmp")) {
					replaced = true;
					await fs.rename(locations.profileDir, displaced);
					await fs.mkdir(locations.profileDir);
					await fs.writeFile(sentinel, "replacement-directory");
				}
				return handle;
			});
			try {
				await expect(vault.add({ name: "TOKEN_B", value: `${VALUE}_b` })).rejects.toThrow(
					/vault directory changed during the transaction/,
				);
			} finally {
				openSpy.mockRestore();
			}

			expect(replaced).toBe(true);
			expect(await fs.readFile(sentinel, "utf8")).toBe("replacement-directory");
			expect(await fs.readdir(locations.profileDir)).toEqual(["sentinel"]);
		});
	});

	/**
	 * A final-component replacement between lstat and open is rejected rather than allowing
	 * an attacker to choose which authenticated snapshot a transaction consumes.
	 */
	it("fails closed when the vault is replaced between pathname and descriptor checks", async () => {
		await withVault(async (vault, locations) => {
			const vaultPath = vaultPathFor(locations, "profile");
			const replacementPath = path.join(locations.profileDir, "prepared-vault");
			await vault.add({ name: "TOKEN_A", value: VALUE });
			const oldBytes = await fs.readFile(vaultPath);
			await vault.add({ name: "TOKEN_B", value: `${VALUE}_b` });
			const newBytes = await fs.readFile(vaultPath);

			await fs.writeFile(vaultPath, oldBytes, { mode: 0o600 });
			await fs.writeFile(replacementPath, newBytes, { mode: 0o600 });
			const realOpen = fs.open;
			let swapped = false;
			const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
				if (!swapped && path.basename(String(args[0])) === VAULT_FILENAME) {
					swapped = true;
					await fs.rename(replacementPath, vaultPath);
				}
				return await Reflect.apply(realOpen, fs, args);
			});
			try {
				await expect(vault.load()).rejects.toThrow(/changed while it was being opened/i);
				expect(await fs.readFile(vaultPath)).toEqual(newBytes);
			} finally {
				openSpy.mockRestore();
			}
		});
	});

	it("fails closed when an opened vault pathname is replaced without touching the substitute", async () => {
		await withVault(async (vault, locations) => {
			const vaultPath = vaultPathFor(locations, "profile");
			const replacementPath = path.join(locations.profileDir, "prepared-vault-after-open");
			await vault.add({ name: "TOKEN_A", value: VALUE });
			const oldBytes = await fs.readFile(vaultPath);
			await vault.add({ name: "TOKEN_B", value: `${VALUE}_b` });
			const newBytes = await fs.readFile(vaultPath);
			await fs.writeFile(replacementPath, newBytes, { mode: 0o600 });
			await fs.writeFile(vaultPath, oldBytes, { mode: 0o600 });

			const realOpen = fs.open;
			let swapped = false;
			const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
				const handle = await Reflect.apply(realOpen, fs, args);
				if (!swapped && path.basename(String(args[0])) === VAULT_FILENAME) {
					swapped = true;
					await fs.rename(replacementPath, vaultPath);
				}
				return handle;
			});
			try {
				await expect(vault.load()).rejects.toThrow(/changed (while it was being opened|during the transaction)/i);
				expect(await fs.readFile(vaultPath)).toEqual(newBytes);
			} finally {
				openSpy.mockRestore();
			}
		});
	});

	/**
	 * A destination that changes after the last userspace check is restored rather than overwritten.
	 *
	 * This is the compare-and-swap seam that plain rename cannot protect. The injected lstat hook
	 * waits until the synced stage exists, then installs another authenticated vault immediately
	 * after the final expected-inode observation.
	 */
	it("restores a vault that races atomic mutation publication", async () => {
		await withVault(async (vault, locations) => {
			const vaultPath = vaultPathFor(locations, "profile");
			const substitutePath = path.join(locations.profileDir, "racing-vault");
			await vault.add({ name: "TOKEN_A", value: VALUE });
			const oldBytes = await fs.readFile(vaultPath);
			await vault.add({ name: "TOKEN_B", value: `${VALUE}_b` });
			const substituteBytes = await fs.readFile(vaultPath);
			await fs.writeFile(vaultPath, oldBytes, { mode: 0o600 });
			await fs.writeFile(substitutePath, substituteBytes, { mode: 0o600 });

			const realLstat = fs.lstat;
			let swapped = false;
			let stagedVaultStats = 0;
			const lstatSpy = spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
				const result = await Reflect.apply(realLstat, fs, args);
				if (!swapped && path.basename(String(args[0])) === VAULT_FILENAME) {
					const entries = await fs.readdir(locations.profileDir);
					if (entries.some(name => name.endsWith(".tmp")) && ++stagedVaultStats === 2) {
						swapped = true;
						await fs.rename(substitutePath, vaultPath);
					}
				}
				return result;
			}) as unknown as typeof fs.lstat);
			try {
				await expect(vault.add({ name: "TOKEN_C", value: `${VALUE}_c` })).rejects.toThrow(
					/changed during the transaction/,
				);
			} finally {
				lstatSpy.mockRestore();
			}

			expect(swapped).toBe(true);
			expect(await fs.readFile(vaultPath)).toEqual(substituteBytes);
			expect((await vault.load()).map(entry => entry.name).sort()).toEqual(["TOKEN_A", "TOKEN_B"]);
		});
	});

	/**
	 * A value too short to obfuscate is refused at the door.
	 *
	 * Consistent with the loader's refusal: storing it would produce an entry that looks
	 * protected and is sent to the provider verbatim. Same rule, same single owner.
	 */
	it("refuses a value too short to protect and reports Unicode characters accurately", async () => {
		await withVault(async vault => {
			await expect(vault.add({ value: "short" })).rejects.toThrow(/under the 8-character minimum/);
			await expect(vault.add({ value: "🔐".repeat(7) })).rejects.toThrow(
				/secret is 7 characters, under the 8-character minimum/i,
			);
		});
	});

	/** An empty value is refused separately, with a message that fits the mistake. */
	it("refuses an empty value", async () => {
		await withVault(async vault => {
			await expect(vault.add({ value: "" })).rejects.toThrow(/cannot be empty/);
		});
	});
});

describe("expiry deletes rather than exposes", () => {
	/**
	 * THE CENTRAL TEST. An expired secret is gone from disk, not merely hidden.
	 *
	 * Reading the vault is what prunes it, so "expired means deleted" is true rather than
	 * aspirational. If this only filtered in memory, the value would sit in the file after its
	 * lifetime ended, which is precisely what a lifetime is supposed to prevent.
	 */
	it("removes an expired entry from the file on the next read", async () => {
		await withVault(async (vault, locations, clock) => {
			await vault.add({ name: "SHORT_LIVED", value: VALUE, ttl: HOUR });
			const before = await fs.readFile(vaultPathFor(locations, "profile"), "utf8");

			clock.now += 2 * HOUR;
			expect(await vault.load()).toEqual([]);

			const after = await fs.readFile(vaultPathFor(locations, "profile"), "utf8");
			expect(after).not.toBe(before);
			// And the value is really gone: re-reading with a fresh vault finds nothing.
			expect(await new SecretVault(locations, () => clock.now).load()).toEqual([]);
		});
	});

	/** A live entry beside an expired one survives the prune. */
	it("keeps live entries when pruning an expired one", async () => {
		await withVault(async (vault, _locations, clock) => {
			await vault.add({ name: "SHORT_LIVED", value: VALUE, ttl: HOUR });
			await vault.add({ name: "LONG_LIVED", value: `${VALUE}_b`, ttl: 7 * DAY });

			clock.now += 2 * HOUR;

			const loaded = await vault.load();
			expect(loaded).toHaveLength(1);
			expect(loaded[0].name).toBe("LONG_LIVED");
		});
	});

	/** Extending measures from now, so a nearly dead secret gets the full window asked for. */
	it("extends from now rather than from the old expiry", async () => {
		await withVault(async (vault, _locations, clock) => {
			await vault.add({ name: "RENEW_ME", value: VALUE, ttl: HOUR });
			clock.now += 59 * 60 * 1000;

			const extended = await vault.extend("RENEW_ME", 7 * DAY);

			expect(extended?.expiresAt).toBe(clock.now + 7 * DAY);
		});
	});

	/** Extending to never clears the expiry entirely. */
	it("can extend to never", async () => {
		await withVault(async vault => {
			await vault.add({ name: "RENEW_ME", value: VALUE, ttl: HOUR });

			expect((await vault.extend("RENEW_ME", null))?.expiresAt).toBeNull();
		});
	});

	/** A rejected extension leaves the existing deadline byte-for-byte effective. */
	it("refuses an unsafe extension without changing the entry", async () => {
		await withVault(async vault => {
			const added = await vault.add({ name: "RENEW_ME", value: VALUE, ttl: HOUR });

			await expect(vault.extend("RENEW_ME", Number.POSITIVE_INFINITY)).rejects.toThrow(
				/finite.*safely representable/,
			);
			expect((await vault.load())[0].expiresAt).toBe(added.expiresAt);
		});
	});

	/** Extending something that is not there reports so rather than inventing an entry. */
	it("returns null when extending an unknown name", async () => {
		await withVault(async vault => {
			expect(await vault.extend("NOT_THERE", DAY)).toBeNull();
		});
	});
});

describe("removal", () => {
	/** Removing reports the scope it came from, since the same name can exist in several. */
	it("removes an entry and names the scope", async () => {
		await withVault(async vault => {
			await vault.add({ name: "TOKEN_A", value: VALUE, scope: "project" });

			expect(await vault.remove("token-a")).toBe("project");
			expect(await vault.load()).toEqual([]);
		});
	});

	/** Removing something absent answers null rather than pretending to succeed. */
	it("returns null when there is nothing to remove", async () => {
		await withVault(async vault => {
			expect(await vault.remove("NOT_THERE")).toBeNull();
		});
	});
});

describe("scope precedence", () => {
	/**
	 * The nearest scope wins on a name clash, matching the rest of veyyon's config.
	 *
	 * Project beats profile beats global. Asserted with all three present at once, because a
	 * two-scope test would pass under several wrong orderings.
	 */
	it("prefers project over profile over global", async () => {
		await withVault(async vault => {
			await vault.add({ name: "SHARED_NAME", value: "global_value_here", scope: "global" });
			await vault.add({ name: "SHARED_NAME", value: "profile_value_here", scope: "profile" });
			await vault.add({ name: "SHARED_NAME", value: "project_value_here", scope: "project" });

			const loaded = await vault.load();
			expect(loaded).toHaveLength(1);
			expect(loaded[0]).toMatchObject({ value: "project_value_here", scope: "project" });
		});
	});

	/**
	 * Running from $HOME makes cwd/.veyyon exactly the global config root. The global path
	 * owns that physical file; loading it a second time as project would apply different AAD
	 * and make a valid global vault fail authentication.
	 */
	it("uses one scope owner when global and project resolve to the same path", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-vault-home-"));
		try {
			const locations: VaultLocations = {
				globalConfigRoot: path.join(home, ".veyyon"),
				profileDir: path.join(home, ".veyyon", "profiles", "work", "agent"),
				projectDir: path.join(home, ".veyyon"),
			};
			await fs.mkdir(locations.globalConfigRoot, { mode: 0o700 });
			const vault = new SecretVault(locations);
			await vault.add({ name: "GLOBAL_TOKEN", value: VALUE, scope: "global" });

			expect(await vault.load()).toEqual([expect.objectContaining({ name: "GLOBAL_TOKEN", scope: "global" })]);
			await expect(vault.add({ name: "PROJECT_TOKEN", value: `${VALUE}_project`, scope: "project" })).rejects.toThrow(
				/project vault path .* is also the global vault path.*different working directory/i,
			);
			expect(await vault.remove("GLOBAL_TOKEN")).toBe("global");
		} finally {
			await fs.rm(home, { recursive: true, force: true });
		}
	});

	it("detects the same scope directory through a symlinked ancestor", async () => {
		if (process.platform === "win32") return;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-vault-ancestor-alias-"));
		try {
			const realHome = path.join(root, "real-home");
			const aliasHome = path.join(root, "alias-home");
			await fs.mkdir(path.join(realHome, ".veyyon"), { recursive: true, mode: 0o700 });
			await fs.chmod(path.join(realHome, ".veyyon"), 0o700);
			await fs.symlink(realHome, aliasHome);
			const locations: VaultLocations = {
				globalConfigRoot: path.join(realHome, ".veyyon"),
				profileDir: path.join(realHome, ".veyyon", "profiles", "work", "agent"),
				projectDir: path.join(aliasHome, ".veyyon"),
			};
			const vault = new SecretVault(locations);
			await vault.add({ name: "GLOBAL_TOKEN", value: VALUE, scope: "global" });

			expect(await vault.load()).toEqual([expect.objectContaining({ name: "GLOBAL_TOKEN", scope: "global" })]);
			await expect(vault.add({ name: "PROJECT_TOKEN", value: `${VALUE}_project`, scope: "project" })).rejects.toThrow(
				/project vault path .* is also the global vault path/i,
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	/** With the project entry gone, the profile one becomes visible again. */
	it("falls back to the next scope when the nearest is removed", async () => {
		await withVault(async vault => {
			await vault.add({ name: "SHARED_NAME", value: "profile_value_here", scope: "profile" });
			await vault.add({ name: "SHARED_NAME", value: "project_value_here", scope: "project" });

			await vault.remove("SHARED_NAME");

			const loaded = await vault.load();
			expect(loaded).toHaveLength(1);
			expect(loaded[0]).toMatchObject({ value: "profile_value_here", scope: "profile" });
		});
	});

	/**
	 * An expired narrow entry no longer shadows the live wider entry for mutations.
	 *
	 * Remove and extend must agree with load's effective-entry view, while also pruning the
	 * expired project copies they encounter.
	 */
	it("acts on a live profile entry behind an expired project shadow", async () => {
		await withVault(async (vault, _locations, clock) => {
			await vault.add({ name: "REMOVE_SHADOW", value: `${VALUE}_profile_remove`, scope: "profile", ttl: 7 * DAY });
			await vault.add({ name: "EXTEND_SHADOW", value: `${VALUE}_profile_extend`, scope: "profile", ttl: 7 * DAY });
			await vault.add({ name: "REMOVE_SHADOW", value: `${VALUE}_project_remove`, scope: "project", ttl: HOUR });
			await vault.add({ name: "EXTEND_SHADOW", value: `${VALUE}_project_extend`, scope: "project", ttl: HOUR });
			clock.now += 2 * HOUR;

			expect(await vault.remove("REMOVE_SHADOW")).toBe("profile");
			const extended = await vault.extend("EXTEND_SHADOW", DAY);

			expect(extended).toMatchObject({ scope: "profile", value: `${VALUE}_profile_extend` });
			expect(extended?.expiresAt).toBe(clock.now + DAY);
			expect(await vault.load()).toEqual([expect.objectContaining({ name: "EXTEND_SHADOW", scope: "profile" })]);
		});
	});

	/**
	 * A vault symlink cannot relabel one profile's ciphertext as another scope.
	 *
	 * Refusal happens at the file seam rather than relying only on decryption, so legacy v1
	 * files receive the same boundary protection.
	 */
	it("refuses a symlink that crosses vault scopes", async () => {
		if (process.platform === "win32") return;
		await withVault(async (vault, locations) => {
			await vault.add({ name: "PROFILE_ONLY", value: VALUE, scope: "profile" });
			const profileVault = vaultPathFor(locations, "profile");
			const projectVault = vaultPathFor(locations, "project");
			await fs.mkdir(locations.projectDir, { recursive: true });
			await fs.symlink(profileVault, projectVault);

			await expect(vault.load()).rejects.toThrow(/project vault .* is a symlink/i);

			await fs.rm(projectVault);
			expect((await vault.load())[0]).toMatchObject({ name: "PROFILE_ONLY", scope: "profile" });
		});
	});

	/** A symlinked scope directory is refused before its regular-looking child is opened. */
	it("refuses a vault reached through a symlinked scope directory", async () => {
		if (process.platform === "win32") return;
		await withVault(async (vault, locations) => {
			await vault.add({ name: "PROFILE_ONLY", value: VALUE, scope: "profile" });
			await fs.mkdir(path.dirname(locations.projectDir), { recursive: true });
			await fs.symlink(locations.profileDir, locations.projectDir);

			await expect(vault.load()).rejects.toThrow(/project vault directory .* is a symlink/i);

			await fs.rm(locations.projectDir);
			expect((await vault.load())[0]).toMatchObject({ name: "PROFILE_ONLY", scope: "profile" });
		});
	});

	/** Even a regular-file copy is rejected when its authenticated scope and path change. */
	it("refuses a sealed vault copied to another scope path", async () => {
		await withVault(async (vault, locations) => {
			await vault.add({ name: "PROFILE_ONLY", value: VALUE, scope: "profile" });
			await fs.mkdir(locations.projectDir, { recursive: true });
			await fs.copyFile(vaultPathFor(locations, "profile"), vaultPathFor(locations, "project"));

			await expect(vault.load()).rejects.toThrow(/different vault location/);
		});
	});

	/** Ciphertext is authenticated to the physical parent inode, not only the same lexical path. */
	it("refuses a vault restored under a recreated scope directory", async () => {
		await withVault(async (vault, locations) => {
			await vault.add({ name: "PHYSICAL_SCOPE_TOKEN", value: VALUE, scope: "profile" });
			const vaultPath = vaultPathFor(locations, "profile");
			const bytes = await fs.readFile(vaultPath);
			const displaced = `${locations.profileDir}.original`;
			await fs.rename(locations.profileDir, displaced);
			await fs.mkdir(locations.profileDir);
			await fs.writeFile(vaultPath, bytes, { mode: 0o600 });

			await expect(vault.load()).rejects.toThrow(/different vault location|could not be decrypted/i);
		});
	});

	/** Directories and other special nodes at a vault filename fail closed. */
	it("refuses a non-regular vault path", async () => {
		await withVault(async (vault, locations) => {
			await fs.mkdir(vaultPathFor(locations, "profile"), { recursive: true });

			await expect(vault.load()).rejects.toThrow(/not a regular file/);
		});
	});

	/** A hard-linked vault cannot acquire a second scope or backup alias while remaining readable. */
	it("refuses a hard-linked vault", async () => {
		if (process.platform === "win32") return;
		await withVault(async (vault, locations) => {
			const vaultPath = vaultPathFor(locations, "profile");
			await vault.add({ name: "PROFILE_ONLY", value: VALUE });
			await fs.link(vaultPath, path.join(locations.profileDir, "vault-alias.json"));

			await expect(vault.load()).rejects.toThrow(/has 2 hard links/);
		});
	});


	/** Distinct names in different scopes all show up. */
	it("returns entries from every scope", async () => {
		await withVault(async vault => {
			await vault.add({ name: "IN_GLOBAL", value: "global_value_here", scope: "global" });
			await vault.add({ name: "IN_PROFILE", value: "profile_value_here", scope: "profile" });
			await vault.add({ name: "IN_PROJECT", value: "project_value_here", scope: "project" });

			expect((await vault.load()).map(e => e.name).sort()).toEqual(["IN_GLOBAL", "IN_PROFILE", "IN_PROJECT"]);
		});
	});

	/** Each scope has its own documented file, so an operator can find and back them up. */
	it("keeps each scope in its own file", async () => {
		await withVault(async (_vault, locations) => {
			expect(vaultPathFor(locations, "global")).toBe(path.join(locations.globalConfigRoot, "vault.json"));
			expect(vaultPathFor(locations, "profile")).toBe(path.join(locations.profileDir, "vault.json"));
			expect(vaultPathFor(locations, "project")).toBe(path.join(locations.projectDir, "vault.json"));
		});
	});
});

describe("a vault whose key is gone", () => {
	/**
	 * A vault with no key is a HARD ERROR, never an empty vault.
	 *
	 * The most important failure in the whole feature. "Empty" would mean every secret the
	 * file holds silently stops being obfuscated and starts reaching the model provider in
	 * plain text, while the session looks perfectly healthy. This is the exact shape of the
	 * bug that DONE-SECRET-1 removed from the loader, so it is asserted here too.
	 */
	it("throws instead of reading as empty", async () => {
		await withVault(async (vault, locations, clock) => {
			await vault.add({ name: "TOKEN_A", value: VALUE });
			await fs.rm(path.join(locations.globalConfigRoot, "vault.key"));

			const fresh = new SecretVault(locations, () => clock.now);
			const failure = await fresh.load().then(
				() => undefined,
				(error: unknown) => error,
			);

			expect(failure).toBeInstanceOf(Error);
			expect((failure as Error).message).toContain("its key does not");
			expect((failure as Error).message).toContain("none of the secrets it holds are being");
		});
	});

	/** A hand-edited vault is refused with advice that does not destroy credentials. */
	it("refuses a vault that is not a sealed file", async () => {
		await withVault(async (vault, locations) => {
			await fs.mkdir(locations.profileDir, { recursive: true });
			await fs.writeFile(vaultPathFor(locations, "profile"), JSON.stringify({ entries: [] }), { mode: 0o600 });

			await expect(vault.load()).rejects.toThrow(/not a sealed vault file/);
		});
	});

	/** Invalid JSON is refused, and the message says the file is not meant to be edited. */
	it("refuses a vault that is not valid JSON", async () => {
		await withVault(async (vault, locations) => {
			await fs.mkdir(locations.profileDir, { recursive: true });
			await fs.writeFile(vaultPathFor(locations, "profile"), "{ truncated", { mode: 0o600 });

			await expect(vault.load()).rejects.toThrow(/not valid JSON/);
		});
	});

	/** Authenticated ciphertext with a malformed entry is corruption, never an empty vault. */
	it("refuses an invalid decrypted vault entry", async () => {
		await withVault(async (vault, locations, clock) => {
			const key = await loadOrCreateVaultKey(locations.globalConfigRoot);
			const vaultPath = vaultPathFor(locations, "profile");
			await fs.mkdir(locations.profileDir, { recursive: true });
			const directoryStat = await fs.lstat(locations.profileDir);
			const canonicalVaultPath = path.join(await fs.realpath(locations.profileDir), path.basename(vaultPath));
			const comparablePath = process.platform === "win32" ? canonicalVaultPath.toLowerCase() : canonicalVaultPath;
			await fs.writeFile(
				vaultPath,
				JSON.stringify(
					sealVault(
						key,
						JSON.stringify({
							entries: [{ name: "TOKEN_A", value: "short", createdAt: clock.now, expiresAt: clock.now + DAY }],
						}),
						`profile\0${comparablePath}\0${directoryStat.dev}\0${directoryStat.ino}`,
					),
				),
				{ mode: 0o600 },
			);

			await expect(vault.load()).rejects.toThrow(/contains an invalid entry/);
		});
	});

	/** No vault at all is not an error: nothing has been stored yet. */
	it("reads empty when no vault exists", async () => {
		await withVault(async vault => {
			expect(await vault.load()).toEqual([]);
		});
	});
});

describe("handing secrets to the obfuscator", () => {
	/** Each live entry arrives with the placeholder the model will see. */
	it("reports every live secret with its named placeholder", async () => {
		await withVault(async vault => {
			await vault.add({ name: "github-token", value: VALUE });

			// `expiresAt` travels with the value, because the obfuscator enforces the lifetime at the
			// moment of use and cannot do that from the value alone. Asserted rather than ignored: a
			// reconcile that dropped this field made every extended secret look like one that never
			// expires. See `expiry-is-enforced-when-used.test.ts`.
			expect(await vault.namedSecrets()).toEqual([
				{ name: "GITHUB_TOKEN", value: VALUE, placeholder: "#GITHUB_TOKEN#", expiresAt: expect.any(Number) },
			]);
		});
	});

	/** An expired secret is not handed over, so it cannot keep being substituted. */
	it("omits an expired secret", async () => {
		await withVault(async (vault, _locations, clock) => {
			await vault.add({ name: "SHORT_LIVED", value: VALUE, ttl: HOUR });
			clock.now += 2 * HOUR;

			expect(await vault.namedSecrets()).toEqual([]);
		});
	});
});

describe("concurrent writers", () => {
	/**
	 * TWO SIMULTANEOUS ADDS BOTH SURVIVE.
	 *
	 * WHY THIS SUITE EXISTS. A vault change is a read-modify-write, and this is a fleet where
	 * several agents share one profile. Unlocked, two adds interleave as read-read-write-write and
	 * the second write discards the first secret: the user stored a credential, watched it be
	 * confirmed, and it was gone with nothing reporting a problem. Every mutation now runs under
	 * `withFileLock`, the same lock `dirs.ts` uses, so this is serialisation rather than a new
	 * locking scheme.
	 *
	 * Ten at once rather than two, because a lost update is a race and one pair can pass by luck.
	 */
	it("keeps every secret when ten adds run at once", async () => {
		await withVault(async vault => {
			await Promise.all(
				Array.from({ length: 10 }, (_unused, index) =>
					vault.add({ name: `TOKEN_${index}`, value: `${VALUE}_${index}` }),
				),
			);

			const loaded = await vault.load();
			expect(loaded).toHaveLength(10);
			expect(loaded.map(entry => entry.name).sort()).toEqual(
				Array.from({ length: 10 }, (_unused, index) => `TOKEN_${index}`).sort(),
			);
			// The values survived intact, not just the names.
			for (const entry of loaded) {
				expect(entry.value).toBe(`${VALUE}_${entry.name.slice("TOKEN_".length)}`);
			}
		});
	});

	/**
	 * Generated names do not collide under contention.
	 *
	 * The name is chosen from the entries visible INSIDE the lock. Chosen from a stale read, two
	 * concurrent unnamed adds would both pick `SECRET_1` and one would overwrite the other.
	 */
	it("gives ten unnamed adds ten distinct names", async () => {
		await withVault(async vault => {
			await Promise.all(Array.from({ length: 10 }, (_unused, index) => vault.add({ value: `${VALUE}_${index}` })));

			const loaded = await vault.load();
			expect(new Set(loaded.map(entry => entry.name)).size).toBe(10);
		});
	});

	/** A remove racing an add leaves the vault consistent rather than corrupt. */
	it("stays consistent when a remove races an add", async () => {
		await withVault(async vault => {
			await vault.add({ name: "FIRST_TOKEN", value: VALUE });

			await Promise.all([vault.remove("FIRST_TOKEN"), vault.add({ name: "SECOND_TOKEN", value: `${VALUE}_b` })]);

			const names = (await vault.load()).map(entry => entry.name);
			expect(names).toContain("SECOND_TOKEN");
			expect(names).not.toContain("FIRST_TOKEN");
		});
	});

	/**
	 * Extend must never resurrect an entry removed after its earlier observation.
	 *
	 * Separate instances reproduce real sessions: whichever operation acquires the lock first
	 * is valid, but once both settle the remove must win and no stale fallback may be appended.
	 */
	it("does not resurrect a secret when remove races extend", async () => {
		await withVault(async (vault, locations, clock) => {
			const rival = new SecretVault(locations, () => clock.now);
			for (let index = 0; index < 10; index++) {
				const name = `RACE_TOKEN_${index}`;
				await vault.add({ name, value: `${VALUE}_${index}`, ttl: DAY });

				const [removed] = await Promise.all([vault.remove(name), rival.extend(name, 7 * DAY)]);

				expect(removed).toBe("profile");
				expect((await vault.load()).some(entry => entry.name === name)).toBe(false);
			}
		});
	});

	/**
	 * A crash between the old lock's mkdir and owner-info write left an empty directory.
	 * Vaults intentionally disable timestamp-only expiry, so recovery must be structural
	 * rather than waiting for an infinite stale deadline.
	 */
	it("recovers an ownerless vault lock even with live-lock expiry disabled", async () => {
		await withVault(async (vault, locations) => {
			const lockPath = `${vaultPathFor(locations, "profile")}.lock`;
			await fs.mkdir(locations.profileDir, { recursive: true });
			await fs.mkdir(lockPath);
			await fs.utimes(lockPath, 0, 0);

			await vault.add({ name: "RECOVERED_TOKEN", value: VALUE });
			expect((await vault.load()).map(entry => entry.name)).toEqual(["RECOVERED_TOKEN"]);
		});
	});

	/**
	 * A live owner is not stale merely because its timestamp is old.
	 *
	 * The shared lock checks both PID and timestamp. Vault operations disable timestamp-only
	 * reaping locally, so a stalled fsync cannot overlap a second writer and lose an update.
	 */
	it("does not reap a live vault lock with an old timestamp", async () => {
		await withVault(async (vault, locations) => {
			const vaultPath = vaultPathFor(locations, "profile");
			const lockPath = `${vaultPath}.lock`;
			const infoPath = path.join(lockPath, "info");
			await fs.mkdir(lockPath, { recursive: true });
			await fs.writeFile(infoPath, JSON.stringify({ pid: process.pid, timestamp: 0, token: "live-test-holder" }));

			const infoObserved = Promise.withResolvers<void>();
			const realOpen = fs.open;
			const openSpy = spyOn(fs, "open").mockImplementation((async (...args: Parameters<typeof fs.open>) => {
				const result = await Reflect.apply(realOpen, fs, args);
				if (String(args[0]) === infoPath) infoObserved.resolve();
				return result;
			}) as unknown as typeof fs.open);
			const realRm = fs.rm;
			let reaped = false;
			const rmSpy = spyOn(fs, "rm").mockImplementation(async (...args) => {
				if (String(args[0]) === lockPath) reaped = true;
				return await Reflect.apply(realRm, fs, args);
			});

			let pending: Promise<unknown> | undefined;
			try {
				pending = vault.add({ name: "WAITED_TOKEN", value: VALUE });
				await infoObserved.promise;
				await Promise.resolve();
				await Promise.resolve();
				expect(reaped).toBe(false);

				await Reflect.apply(realRm, fs, [lockPath, { recursive: true, force: true }]);
				await pending;
			} finally {
				await Reflect.apply(realRm, fs, [lockPath, { recursive: true, force: true }]);
				if (pending !== undefined) await pending.catch(() => {});
				openSpy.mockRestore();
				rmSpy.mockRestore();
			}
			expect((await vault.load()).map(entry => entry.name)).toEqual(["WAITED_TOKEN"]);
		});
	});
});
