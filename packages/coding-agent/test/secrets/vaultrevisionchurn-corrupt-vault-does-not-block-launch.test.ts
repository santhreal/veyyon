/**
 * Where the loader may degrade past a broken vault, and where it must still refuse.
 *
 * THE BUG THIS LOCKS OUT, PART ONE. A vault whose decrypted payload will not parse used to be
 * FATAL. The throw escaped `load()`, escaped the secret-runtime build, and killed the process
 * before the TUI drew a frame: exit 1, no frame, and the operator locked out of the `/secret`
 * commands that are the only in-product way to repair it. A fatal error whose one fix lives inside
 * the product it refuses to start is not fail-closed, it is a dead end.
 *
 * THE BUG THIS LOCKS OUT, PART TWO, and it is the more dangerous one because the first fix caused
 * it. The degrade was originally written as a catch around the whole per-scope read. That quietly
 * converted every security refusal in the loader into "that scope has no secrets": a hardlinked
 * vault, a symlink crossing scopes, a sealed vault copied into another scope, a world-readable
 * vault, an oversized vault, unknowable legacy provenance, and a TOCTOU replacement between the
 * pathname and descriptor checks. Each is an attacker signal. Worse, a dropped scope drops its
 * values out of the obfuscator, so a credential the operator later pastes is no longer redacted on
 * its way to the provider. A boot refusal had become a silent disclosure path.
 *
 * So the contract is a BOUNDARY, and this suite pins it from both sides:
 *   - Cleared every provenance and integrity check, payload still unparseable -> skip with a notice.
 *   - Anything else -> refuse, exactly as before.
 *
 * IF THIS REGRESSES: either one hand-corrupted file bricks the terminal again, or the loader starts
 * shrugging off planted vaults. Do NOT make a failure in the second group pass by widening what
 * `load()` catches. Widening it is the original defect.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { attachSecretsNoticeSink } from "@veyyon/coding-agent/secrets/notices";
import { SecretVault, type VaultLocations, vaultPathFor } from "@veyyon/coding-agent/secrets/vault";
import * as vaultCrypto from "@veyyon/coding-agent/secrets/vault-crypto";
import { useSpyTeardown } from "../helpers/spy-teardown";

const roots = new Set<string>();
const detachers = new Set<() => void>();
/**
 * The shared registry, rather than a hand-rolled Set of undo closures.
 *
 * The spy below replaces `openVault` on an imported MODULE OBJECT, so a leaked one would poison
 * every later row IN THIS FILE that decrypts a vault. That is the whole blast radius, and it is
 * measured rather than reasoned: bun restores spies at the end of each test FILE, so the
 * process-global escape this helper was first justified with does not happen. Within-file damage is
 * reason enough on its own, because a row killed by the deadline never reaches its own `finally`
 * and every remaining row in the file then runs against a live mock, which reads as a deadlock in
 * the code under test rather than as one broken row. This suite parks no waiters, so it never
 * produced the hang that motivated the helper; the reason to consume the shared registry anyway is
 * that a second hand-rolled convention beside it is how the next suite ends up with a third.
 */
const teardown = useSpyTeardown();

const VALUE = "a_secret_value_long_enough_to_protect";

/** Marks the one vault a test wants to see corrupted, without touching any other scope. */
const DOOMED_NAME = "CORRUPT_THIS_SCOPE";

interface Fixture {
	readonly locations: VaultLocations;
	readonly vault: SecretVault;
}

async function fixture(): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-corrupt-vault-"));
	roots.add(root);
	const locations: VaultLocations = {
		globalConfigRoot: path.join(root, "config"),
		profileDir: path.join(root, "config", "profiles", "work", "agent"),
		projectDir: path.join(root, "project", ".veyyon"),
	};
	return { locations, vault: new SecretVault(locations) };
}

/** Collect operator notices for the duration of one test. */
function captureNotices(): string[] {
	const seen: string[] = [];
	const detach = attachSecretsNoticeSink(message => seen.push(message));
	detachers.add(detach);
	return seen;
}

/** Overwrite a vault file, keeping the owner-only mode a real vault carries. */
async function overwriteVault(vaultPath: string, contents: string | Uint8Array): Promise<void> {
	await fs.writeFile(vaultPath, contents);
	await fs.chmod(vaultPath, 0o600);
}

/**
 * Corrupt the DECRYPTED payload of whichever vault holds {@link DOOMED_NAME}, and nothing else.
 *
 * This is the only failure the loader may skip, and reaching it needs a file that is otherwise
 * beyond reproach: correct inode, owner-only mode, within the size bound, no symlink or hardlink,
 * not a copy from another scope, and an AEAD tag that authenticates against this scope's binding.
 * Every one of those is a real property of the file this leaves on disk, because the file is a
 * genuine vault written by the real write path and is never touched.
 *
 * So the corruption is injected at the ONE seam past all of it, by letting the real `openVault`
 * authenticate normally and then spoiling the plaintext it returns. Writing garbage to the file
 * instead cannot reach this branch: it fails the envelope parse or the AEAD tag first, which is a
 * different case that must still refuse, and is asserted separately below.
 *
 * Keyed on the entry name rather than on call order so a test can corrupt one scope and leave the
 * others genuinely readable. Returns the spy so a row can restore it MID-test, which the
 * break/repair/break row below needs; teardown still undoes it, and both undos are idempotent.
 */
function corruptDecryptedPayloadOfDoomedScope() {
	const real = vaultCrypto.openVault;
	return teardown.spy(vaultCrypto, "openVault").mockImplementation((key, sealed, binding) => {
		const plaintext = real(key, sealed, binding);
		return plaintext.includes(DOOMED_NAME) ? '{ "entries": [ this is not json' : plaintext;
	});
}

/**
 * Damage the sealed payload without touching the envelope, so the AEAD tag no longer verifies.
 *
 * Flips a character inside the longest string in the file, which is the ciphertext. Deliberately
 * not keyed to a field name, so it keeps corrupting something even if the envelope's shape changes;
 * asserts it changed something, because a test that silently stopped corrupting would pass for the
 * wrong reason.
 */
async function flipSealedPayload(vaultPath: string): Promise<void> {
	const envelope = JSON.parse(await Bun.file(vaultPath).text()) as Record<string, unknown>;
	const widest = Object.entries(envelope)
		.filter((pair): pair is [string, string] => typeof pair[1] === "string")
		.sort((left, right) => right[1].length - left[1].length)[0];
	if (widest === undefined) throw new Error("The sealed vault has no string field to corrupt.");
	const [key, text] = widest;
	const middle = Math.floor(text.length / 2);
	const replacement = text[middle] === "A" ? "B" : "A";
	envelope[key] = `${text.slice(0, middle)}${replacement}${text.slice(middle + 1)}`;
	expect(envelope[key]).not.toBe(text);
	await overwriteVault(vaultPath, JSON.stringify(envelope));
}

/**
 * Ways a vault file can be broken that are NOT the degradable case.
 *
 * Every one of these fails a provenance or integrity check: the envelope will not parse, or it
 * parses and the AEAD tag does not authenticate. None of them can be told apart from a planted
 * file by inspecting content, which is exactly why they must refuse rather than skip.
 */
const MUST_REFUSE: ReadonlyArray<{ readonly what: string; readonly break: (vaultPath: string) => Promise<void> }> = [
	{
		what: "truncated mid-object, as a hand edit leaves it",
		break: vaultPath => overwriteVault(vaultPath, "{ this is not json"),
	},
	{
		what: "valid JSON that is not a vault envelope",
		break: vaultPath => overwriteVault(vaultPath, '{"unexpected":"shape"}'),
	},
	{
		what: "valid JSON of the wrong type entirely",
		break: vaultPath => overwriteVault(vaultPath, "[]"),
	},
	{
		what: "empty, as an interrupted write leaves it",
		break: vaultPath => overwriteVault(vaultPath, ""),
	},
	{
		what: "raw binary, as a bad disk leaves it",
		break: vaultPath => overwriteVault(vaultPath, new Uint8Array([0, 1, 2, 250, 251, 252, 0])),
	},
	{
		what: "sealed but no longer authenticating",
		break: flipSealedPayload,
	},
];

afterEach(async () => {
	for (const detach of detachers) detach();
	detachers.clear();
	await Promise.all([...roots].map(root => fs.rm(root, { recursive: true, force: true })));
	roots.clear();
});

describe("a vault that fails a provenance or integrity check", () => {
	for (const corruption of MUST_REFUSE) {
		/**
		 * The loader must REFUSE, not skip. Skipping drops the scope's secrets out of the
		 * obfuscator, and a credential that is absent is a credential that stops being redacted.
		 */
		it(`still refuses to load when the profile vault is ${corruption.what}`, async () => {
			const { locations, vault } = await fixture();
			await vault.add({ name: "PROFILE_TOKEN", value: VALUE, scope: "profile", ttl: null });

			await corruption.break(vaultPathFor(locations, "profile"));

			await expect(new SecretVault(locations).load()).rejects.toThrow();
		});
	}

	/** A refusal must not be downgraded to a notice either: silence is the failure mode. */
	it("reports the refusal by throwing rather than by raising a notice", async () => {
		const { locations, vault } = await fixture();
		await vault.add({ name: "PROFILE_TOKEN", value: VALUE, scope: "profile", ttl: null });
		await overwriteVault(vaultPathFor(locations, "profile"), "{ this is not json");

		const notices = captureNotices();
		await expect(new SecretVault(locations).load()).rejects.toThrow();

		expect(notices).toEqual([]);
	});

	/**
	 * Adversarial. A parser names the token it choked on, and this file is a credential store, so
	 * the parser's own message is a natural way for ciphertext or plaintext to reach a transcript.
	 */
	it("never quotes bytes of the vault file back into the failure", async () => {
		const { locations, vault } = await fixture();
		await vault.add({ name: "PROFILE_TOKEN", value: VALUE, scope: "profile", ttl: null });
		const smuggled = "ghp_thisLooksExactlyLikeACredential0000";
		await overwriteVault(vaultPathFor(locations, "profile"), `{"entries": [${smuggled} `);

		await expect(new SecretVault(locations).load()).rejects.toThrow(
			expect.not.stringContaining(smuggled) as unknown as string,
		);
	});
});

describe("a vault that is beyond reproach except for its payload", () => {
	/**
	 * The whole point of the degrade: a session still starts, and only the broken scope is missing.
	 * A fresh SecretVault stands in for the next launch, which is where the crash happened.
	 */
	it("skips only that scope and still loads every other one", async () => {
		const { locations, vault } = await fixture();
		await vault.add({ name: "GLOBAL_TOKEN", value: `${VALUE}_global`, scope: "global", ttl: null });
		await vault.add({ name: DOOMED_NAME, value: `${VALUE}_profile`, scope: "profile", ttl: null });

		corruptDecryptedPayloadOfDoomedScope();

		const names = (await new SecretVault(locations).load()).map(entry => entry.name);
		expect(names).toEqual(["GLOBAL_TOKEN"]);
	});

	/** `/secret list` reads through namedSecrets, and it is how the operator finds the damage. */
	it("keeps the secret listing reachable instead of failing it", async () => {
		const { locations, vault } = await fixture();
		await vault.add({ name: "SURVIVOR", value: VALUE, scope: "global", ttl: null });
		await vault.add({ name: DOOMED_NAME, value: `${VALUE}_2`, scope: "profile", ttl: null });

		corruptDecryptedPayloadOfDoomedScope();

		const listed = await new SecretVault(locations).namedSecrets();
		expect(listed.map(entry => entry.name)).toEqual(["SURVIVOR"]);
	});

	/**
	 * The primitive the spend guard consumes. Without it a skipped scope is indistinguishable from
	 * "you never stored that secret", and an unresolvable placeholder would reach a command as the
	 * literal text `#NAME#` rather than being refused.
	 */
	it("reports which scope was skipped", async () => {
		const { locations, vault } = await fixture();
		await vault.add({ name: DOOMED_NAME, value: VALUE, scope: "profile", ttl: null });

		corruptDecryptedPayloadOfDoomedScope();

		const relaunched = new SecretVault(locations);
		await relaunched.load();
		expect(relaunched.unreadableScopes()).toEqual(["profile"]);
	});

	/** The negative control on that primitive: a healthy vault must never claim to be broken. */
	it("reports no skipped scope for a vault that reads normally", async () => {
		const { locations, vault } = await fixture();
		await vault.add({ name: "HEALTHY", value: VALUE, scope: "profile", ttl: null });

		const relaunched = new SecretVault(locations);
		await relaunched.load();
		expect(relaunched.unreadableScopes()).toEqual([]);
	});

	/** Silent degradation would be worse than the crash: the operator must be told, with the fix. */
	it("raises an operator notice naming the file and the repair", async () => {
		const { locations, vault } = await fixture();
		await vault.add({ name: DOOMED_NAME, value: VALUE, scope: "profile", ttl: null });
		const vaultPath = vaultPathFor(locations, "profile");

		corruptDecryptedPayloadOfDoomedScope();
		const notices = captureNotices();
		await new SecretVault(locations).load();

		expect(notices).toHaveLength(1);
		const notice = notices[0] ?? "";
		expect(notice).toContain(vaultPath);
		expect(notice).toContain("could not be read");
		expect(notice).toContain("/secret discard --scope profile");
		expect(notice).toContain("move the unreadable file aside");
		// Every command a notice names has to run on the surface reading it, and this one is raised by
		// the vault loader, which cannot know that surface. `add` is the counter-example held here: in
		// a terminal the line after `/secret` is the credential, so advice naming it would be stored.
		expect(notice).not.toContain("/secret add");
		expect(notice).not.toContain("manager");
	});

	/** A notice ending in ".." reached a real terminal, because parser messages punctuate themselves. */
	it("does not double the sentence-ending punctuation", async () => {
		const { locations, vault } = await fixture();
		await vault.add({ name: DOOMED_NAME, value: VALUE, scope: "profile", ttl: null });

		corruptDecryptedPayloadOfDoomedScope();
		const notices = captureNotices();
		await new SecretVault(locations).load();

		expect(notices[0] ?? "").not.toContain("..");
	});

	/** No vault is the ordinary case and must stay quiet, or every fresh install warns. */
	it("raises no notice when a vault is simply absent", async () => {
		const { locations } = await fixture();

		const notices = captureNotices();
		expect(await new SecretVault(locations).load()).toEqual([]);

		expect(notices).toEqual([]);
	});

	/**
	 * The other half of the contract. Reading tolerates the broken payload; WRITING must not,
	 * because a write that treated it as empty would replace entries the operator may still
	 * recover, and recovery is plausible here precisely because the file authenticates.
	 */
	it("still refuses to write to the skipped scope, leaving its bytes untouched", async () => {
		const { locations, vault } = await fixture();
		await vault.add({ name: DOOMED_NAME, value: VALUE, scope: "profile", ttl: null });
		const vaultPath = vaultPathFor(locations, "profile");
		const before = await Bun.file(vaultPath).text();

		corruptDecryptedPayloadOfDoomedScope();
		const relaunched = new SecretVault(locations);
		await relaunched.load();

		await expect(
			relaunched.add({ name: "NEW_TOKEN", value: `${VALUE}_new`, scope: "profile", ttl: null }),
		).rejects.toThrow();
		expect(await Bun.file(vaultPath).text()).toBe(before);
	});
});

describe("the skipped-vault notice across repeated reads", () => {
	/** load() runs on every runtime refresh; an unmissable warning repeated becomes wallpaper. */
	it("reports one unchanged broken state only once", async () => {
		const { locations, vault } = await fixture();
		await vault.add({ name: DOOMED_NAME, value: VALUE, scope: "profile", ttl: null });

		corruptDecryptedPayloadOfDoomedScope();
		const notices = captureNotices();
		const relaunched = new SecretVault(locations);
		await relaunched.load();
		await relaunched.load();
		await relaunched.load();

		expect(notices).toHaveLength(1);
	});

	/**
	 * The dedupe's dangerous edge, and the one it originally got wrong.
	 *
	 * Comparing against the last state REPORTED is not enough on its own: break, repair, then break
	 * again, and the remembered state still matches the first break, so the second is silenced by a
	 * memory of the first. A warning that shows once per process and then never again is how a
	 * broken vault ships unnoticed. The fix is to forget on SUCCESS, which is what this pins. The
	 * repair here is genuine, and the second break is identical to the first, which is what defeats
	 * any scheme that relies on the file looking different.
	 */
	it("reports the same breakage again after a repair in between", async () => {
		const { locations, vault } = await fixture();
		await vault.add({ name: DOOMED_NAME, value: VALUE, scope: "profile", ttl: null });
		const vaultPath = vaultPathFor(locations, "profile");

		const notices = captureNotices();
		const relaunched = new SecretVault(locations);

		const spy = corruptDecryptedPayloadOfDoomedScope();
		await relaunched.load();
		expect(notices).toHaveLength(1);

		// Repair: the doomed entry is gone, so the payload stops being spoiled.
		spy.mockRestore();
		await fs.unlink(vaultPath);
		await relaunched.add({ name: "REPAIRED", value: `${VALUE}_ok`, scope: "profile", ttl: null });
		await relaunched.load();
		expect(notices).toHaveLength(1);

		await relaunched.add({ name: DOOMED_NAME, value: VALUE, scope: "profile", ttl: null });
		corruptDecryptedPayloadOfDoomedScope();
		await relaunched.load();
		expect(notices).toHaveLength(2);
	});
});
