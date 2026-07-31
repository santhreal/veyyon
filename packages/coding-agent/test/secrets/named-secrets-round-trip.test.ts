/**
 * A named vault secret, from storage to the command that spends it.
 *
 * WHY THIS SUITE EXISTS. The vault is only useful if the whole path holds: the value is
 * stored encrypted, the model is shown a name it can choose deliberately, the model writes
 * that name into a command, and the real credential appears in the command and nowhere else.
 * Each layer has its own tests; this one asserts they compose, because every individual layer
 * can be correct while the seam between two of them drops the value or leaks it.
 *
 * The assertions are about REAL VALUES: the exact placeholder, the exact command string after
 * substitution, and the absence of the credential from everything the model or the transcript
 * would see. A test that only checked "something was replaced" would pass while substituting
 * the wrong secret, which is the specific failure named placeholders exist to prevent.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { deobfuscateToolArguments, SecretObfuscator } from "@veyyon/coding-agent/secrets";
import { SecretVault, type VaultLocations } from "@veyyon/coding-agent/secrets/vault";

const GITHUB = "ghp_this_is_the_github_credential";
const AWS = "aws_this_is_the_aws_credential";

async function withVault(body: (vault: SecretVault, locations: VaultLocations) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-named-"));
	try {
		await body(
			new SecretVault({
				globalConfigRoot: path.join(root, "config"),
				profileDir: path.join(root, "config", "profiles", "work", "agent"),
				projectDir: path.join(root, "project", ".veyyon"),
			}),
			{
				globalConfigRoot: path.join(root, "config"),
				profileDir: path.join(root, "config", "profiles", "work", "agent"),
				projectDir: path.join(root, "project", ".veyyon"),
			},
		);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

/** Build an obfuscator over everything currently live in a vault. */
async function obfuscatorFor(vault: SecretVault): Promise<SecretObfuscator> {
	const named = await vault.namedSecrets();
	return new SecretObfuscator(
		named.map(secret => ({ type: "plain", origin: "config", content: secret.value, name: secret.name })),
	);
}

describe("a named secret becomes a name the model can choose", () => {
	/**
	 * The model sees the NAME, not a hash. This is the whole point of naming.
	 *
	 * With an index-derived token the model gets `#A1B2#` and has no way to know which
	 * credential it stands for; with two secrets loaded it can only guess.
	 */
	it("shows the name as the placeholder", async () => {
		await withVault(async vault => {
			await vault.add({ name: "github-token", value: GITHUB });
			const obfuscator = await obfuscatorFor(vault);

			expect(obfuscator.obfuscate(`token is ${GITHUB}`)).toBe("token is #GITHUB_TOKEN#");
		});
	});

	/**
	 * Two secrets stay distinguishable, which an index form cannot promise across sessions.
	 *
	 * The failure this prevents: the agent putting the AWS credential in the GitHub request
	 * because both placeholders were opaque four-character tokens.
	 */
	it("keeps two secrets apart by name", async () => {
		await withVault(async vault => {
			await vault.add({ name: "github-token", value: GITHUB });
			await vault.add({ name: "aws-key", value: AWS });
			const obfuscator = await obfuscatorFor(vault);

			const text = `gh=${GITHUB} aws=${AWS}`;
			expect(obfuscator.obfuscate(text)).toBe("gh=#GITHUB_TOKEN# aws=#AWS_KEY#");
		});
	});

	/**
	 * The placeholder is the same in a later session, because it comes from the name.
	 *
	 * An index-derived token is a function of load order, so adding an unrelated secret could
	 * change what an existing one is called. A transcript written yesterday still resolves.
	 */
	it("gives the same placeholder after another secret is added", async () => {
		await withVault(async vault => {
			await vault.add({ name: "github-token", value: GITHUB });
			const before = (await obfuscatorFor(vault)).obfuscate(GITHUB);

			await vault.add({ name: "aws-key", value: AWS });
			const after = (await obfuscatorFor(vault)).obfuscate(GITHUB);

			expect(before).toBe("#GITHUB_TOKEN#");
			expect(after).toBe("#GITHUB_TOKEN#");
		});
	});
});

describe("the command gets the real credential", () => {
	/**
	 * THE CENTRAL PATH. The model writes the placeholder; the command runs with the value.
	 *
	 * `deobfuscateToolArguments` is what the tool layer calls before a command executes, so
	 * this is the substitution the shell actually sees. Asserted as an exact string, because
	 * a partial substitution would produce a request that fails in a confusing way.
	 */
	it("substitutes the value into tool arguments", async () => {
		await withVault(async vault => {
			await vault.add({ name: "github-token", value: GITHUB });
			const obfuscator = await obfuscatorFor(vault);

			const asWritten = { command: 'curl -H "Authorization: Bearer #GITHUB_TOKEN#" https://api.github.com' };
			const asExecuted = deobfuscateToolArguments(obfuscator, asWritten);

			expect(asExecuted.command).toBe(`curl -H "Authorization: Bearer ${GITHUB}" https://api.github.com`);
		});
	});

	/** The right secret goes to the right place when two are in play. */
	it("substitutes each named secret independently", async () => {
		await withVault(async vault => {
			await vault.add({ name: "github-token", value: GITHUB });
			await vault.add({ name: "aws-key", value: AWS });
			const obfuscator = await obfuscatorFor(vault);

			const executed = deobfuscateToolArguments(obfuscator, {
				command: "deploy --gh #GITHUB_TOKEN# --aws #AWS_KEY#",
			});

			expect(executed.command).toBe(`deploy --gh ${GITHUB} --aws ${AWS}`);
		});
	});

	/**
	 * An unknown placeholder is left alone rather than blanked.
	 *
	 * A model can invent a token, and a user can type `#HELLO#` in prose. Substituting an
	 * empty string would silently produce a command missing an argument; leaving it visible
	 * makes the mistake obvious in the command that failed.
	 */
	it("leaves an unknown placeholder untouched", async () => {
		await withVault(async vault => {
			await vault.add({ name: "github-token", value: GITHUB });
			const obfuscator = await obfuscatorFor(vault);

			expect(deobfuscateToolArguments(obfuscator, { command: "echo #NOT_A_SECRET#" }).command).toBe(
				"echo #NOT_A_SECRET#",
			);
		});
	});
});

describe("adding a secret mid-session", () => {
	/**
	 * A secret added during a session starts being protected immediately.
	 *
	 * `/secret` has to work without a restart, or the feature is unusable at the moment
	 * someone actually needs it. The obfuscator is built once at startup, so it has to accept
	 * an append.
	 */
	it("protects a value added after construction", () => {
		const obfuscator = new SecretObfuscator([]);

		const placeholder = obfuscator.addNamedSecret("DEPLOY_TOKEN", GITHUB);

		expect(placeholder).toBe("#DEPLOY_TOKEN#");
		expect(obfuscator.obfuscate(`t=${GITHUB}`)).toBe("t=#DEPLOY_TOKEN#");
		expect(obfuscator.hasNamedSecret("DEPLOY_TOKEN")).toBe(true);
	});

	/**
	 * An append does not disturb placeholders already in use.
	 *
	 * The reason `addNamedSecret` is append-only. Index-derived tokens are a function of
	 * position, so an insert would renumber every later secret while transcripts on disk still
	 * hold the old tokens.
	 */
	it("leaves an existing secret's placeholder unchanged", () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", origin: "config", content: AWS }]);
		const before = obfuscator.obfuscate(AWS);

		obfuscator.addNamedSecret("DEPLOY_TOKEN", GITHUB);

		expect(obfuscator.obfuscate(AWS)).toBe(before);
		expect(obfuscator.obfuscate(GITHUB)).toBe("#DEPLOY_TOKEN#");
	});

	/** A session that began with no secrets can still gain one. */
	it("turns an empty obfuscator into an active one", () => {
		const obfuscator = new SecretObfuscator([]);
		expect(obfuscator.hasSecrets()).toBe(false);

		obfuscator.addNamedSecret("DEPLOY_TOKEN", GITHUB);

		expect(obfuscator.hasSecrets()).toBe(true);
	});

	/** Adding the same name and value twice is idempotent rather than duplicating state. */
	it("is idempotent for an unchanged value", () => {
		const obfuscator = new SecretObfuscator([]);

		expect(obfuscator.addNamedSecret("DEPLOY_TOKEN", GITHUB)).toBe("#DEPLOY_TOKEN#");
		expect(obfuscator.addNamedSecret("DEPLOY_TOKEN", GITHUB)).toBe("#DEPLOY_TOKEN#");
		expect(obfuscator.obfuscate(GITHUB)).toBe("#DEPLOY_TOKEN#");
	});

	/** A value too short to protect is refused here too, so storage cannot outrun protection. */
	it("refuses a value too short to protect", () => {
		const obfuscator = new SecretObfuscator([]);

		expect(() => obfuscator.addNamedSecret("DEPLOY_TOKEN", "short")).toThrow(/under the 8-character minimum/);
		expect(obfuscator.hasNamedSecret("DEPLOY_TOKEN")).toBe(false);
	});
});

describe("forgetting a secret", () => {
	/**
	 * A forgotten secret stops being substituted but remains redacted.
	 *
	 * Expiry deletes from the vault, and the running obfuscator has to revoke expansion or
	 * a command would keep spending the credential. Dropping forward redaction at the same
	 * time would expose old transcript text, so the raw value moves to an opaque tombstone.
	 */
	it("revokes expansion while retaining a redaction tombstone", () => {
		const obfuscator = new SecretObfuscator([]);
		obfuscator.addNamedSecret("DEPLOY_TOKEN", GITHUB);

		obfuscator.forgetNamedSecret("DEPLOY_TOKEN");

		expect(obfuscator.hasNamedSecret("DEPLOY_TOKEN")).toBe(false);
		expect(obfuscator.obfuscate(`t=${GITHUB}`)).not.toContain(GITHUB);
		expect(obfuscator.deobfuscate("#DEPLOY_TOKEN#")).toBe("#DEPLOY_TOKEN#");
	});

	/**
	 * A command carrying a forgotten placeholder is refused before execution.
	 *
	 * Leaving the token in the command made a remote authentication failure look like an ordinary
	 * bad credential. The refusal names only the retired placeholder and tells the operator to
	 * store it again, while the raw value remains unavailable.
	 */
	it("refuses a forgotten placeholder at the tool boundary", () => {
		const obfuscator = new SecretObfuscator([]);
		obfuscator.addNamedSecret("DEPLOY_TOKEN", GITHUB);
		obfuscator.forgetNamedSecret("DEPLOY_TOKEN");

		expect(() => deobfuscateToolArguments(obfuscator, { command: "use #DEPLOY_TOKEN#" })).toThrow(
			/Stored secret #DEPLOY_TOKEN# is no longer available/,
		);
	});

	/** Forgetting something absent is a no-op rather than an error. */
	it("ignores a name it does not hold", () => {
		const obfuscator = new SecretObfuscator([]);

		expect(() => obfuscator.forgetNamedSecret("NOT_THERE")).not.toThrow();
	});
});
