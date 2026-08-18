/**
 * `/secret copy` hands the surface a placeholder, and no `/secret` verb ever hands it a value.
 *
 * WHY THIS SUITE EXISTS. Copying used to be a keystroke on a card row, and the card is gone: copy is
 * a verb now, reachable from a terminal and from a client with no screen. That moves the clipboard
 * write behind the same parser as everything else, and it makes the question worth asking once for
 * the whole grammar rather than once for the card: what can a `/secret` result put in front of
 * somebody, and can any of it be the credential?
 *
 * The answer has to be no, for a reason that is not about copy. A result's `message` reaches the
 * scrollback and the saved transcript, `copyText` reaches the system clipboard where other processes
 * can read it, and `agentNotice` reaches the model. A credential in any of the three defeats the
 * point of storing it in an encrypted vault, and each of those is a different place it cannot be
 * taken back out of.
 *
 * WHAT IT CLOSES. Two things. The `copy` contract itself: the clipboard receives `#NAME#` and the
 * message says so, the scope reported is the one the placeholder actually spends, and an unknown name
 * is refused with the command that lists what is stored. And the class around it: every verb in the
 * grammar is run against a vault that holds a real credential, and none of them may put those bytes
 * in a message, a notice or a clipboard. A new verb has to be given a request here before this file
 * compiles, so it cannot join the grammar without answering the question.
 *
 * WHAT IT DOES NOT CATCH. Whether the surface honours `copyText` at all: writing it to the system
 * clipboard belongs to the caller, and the port that does it is asserted where the flow is. It also
 * says nothing about expansion, where the real value is deliberately handed to a tool.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	runSecretCommand,
	type SecretCommandRequest,
	type SecretSubcommand,
} from "@veyyon/coding-agent/secrets/secret-command";
import { SecretVault, type VaultScope } from "@veyyon/coding-agent/secrets/vault";

/** Long enough to clear the vault's obfuscatable-length floor, and distinctive enough to grep for. */
const STORED = "ghp_storedCredential0123456789";
const REPLACEMENT = "ghp_replacementCredential98765";
const ADDED = "ghp_addedCredential0123456789";

const DAY = 86_400_000;
const NOW = Date.parse("2026-08-01T09:00:00Z");

async function vaultHolding(scope: VaultScope): Promise<{ vault: SecretVault; cleanup: () => Promise<void> }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-secret-copy-"));
	const vault = new SecretVault(
		{
			globalConfigRoot: path.join(root, "global"),
			profileDir: path.join(root, "profile"),
			projectDir: path.join(root, "project"),
		},
		() => NOW,
	);
	await vault.add({ name: "DEPLOY_KEY", value: STORED, scope, ttl: DAY });
	return { vault, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

function contextFor(vault: SecretVault) {
	return { vault, readEnv: () => undefined, defaultTtl: DAY, now: NOW };
}

describe("copying a stored secret", () => {
	/** The whole point of the verb: the clipboard gets the token to write, never the credential. */
	it("puts the placeholder on the clipboard and says the value was not copied", async () => {
		const { vault, cleanup } = await vaultHolding("profile");
		try {
			const result = await runSecretCommand({ subcommand: "copy", name: "DEPLOY_KEY" }, contextFor(vault));

			expect(result.copyText).toBe("#DEPLOY_KEY#");
			expect(result.message).toContain("#DEPLOY_KEY#");
			expect(result.message).toContain("The value is never copied.");
			// Copying changes nothing, so a caller must not be told to reload the vault for it.
			expect(result.changed).toBe(false);
		} finally {
			await cleanup();
		}
	});

	/** The name is normalised on the way in, the way every other verb reads one. */
	it("finds the entry through the vault's own name normalisation", async () => {
		const { vault, cleanup } = await vaultHolding("profile");
		try {
			const result = await runSecretCommand({ subcommand: "copy", name: "deploy key" }, contextFor(vault));

			expect(result.copyText).toBe("#DEPLOY_KEY#");
		} finally {
			await cleanup();
		}
	});

	/**
	 * The scope reported is the one the placeholder spends, not the one it is also stored in.
	 *
	 * A name held in two vaults resolves to the narrowest, and `copy` reads the resolved view for
	 * exactly that reason: reporting the wrong scope would tell the operator to remove the copy that
	 * is not the one in effect.
	 */
	it("names the scope in effect when the same name is held twice", async () => {
		const { vault, cleanup } = await vaultHolding("profile");
		try {
			await vault.add({ name: "DEPLOY_KEY", value: `${STORED}_project`, scope: "project", ttl: DAY });

			const result = await runSecretCommand({ subcommand: "copy", name: "DEPLOY_KEY" }, contextFor(vault));

			expect(result.message).toContain("project secret");
			expect(result.copyText).toBe("#DEPLOY_KEY#");
		} finally {
			await cleanup();
		}
	});

	/** A refusal that only refuses is a wall, so it names the command that answers the question. */
	it("refuses a name that is not stored and says how to see what is", async () => {
		const { vault, cleanup } = await vaultHolding("profile");
		try {
			await expect(runSecretCommand({ subcommand: "copy", name: "NOT_STORED" }, contextFor(vault))).rejects.toThrow(
				/No secret named NOT_STORED is stored\. Run \/secret list to see what is\./,
			);
		} finally {
			await cleanup();
		}
	});
});

/**
 * One request per verb, exhaustive by type so a new verb cannot be added without a decision here.
 *
 * The requests are hand-built rather than parsed, because the point is to reach every runner branch
 * including the ones a terminal reaches only through a masked field.
 */
const REQUESTS: Record<SecretSubcommand, SecretCommandRequest> = {
	add: { subcommand: "add", name: "SECOND_KEY", value: ADDED },
	// Same runner as `add`, reached with the value coming out of the environment instead of a field.
	// The variable is deliberately one nothing sets, so this row takes the refusal path, which is a
	// string on the same screen and therefore in scope for a leak.
	"from-env": { subcommand: "from-env", name: "THIRD_KEY", fromEnv: "VEYYON_UNSET_FOR_COPY_SUITE" },
	list: { subcommand: "list" },
	rm: { subcommand: "rm", name: "DEPLOY_KEY" },
	// `profile` deliberately, which is the scope `vaultHolding` seeded: clearing an EMPTY scope would
	// take the "nothing was removed" branch and prove nothing about what a report names, and naming
	// is the whole risk here since this verb reports every entry it touched.
	clear: { subcommand: "clear", scope: "profile" },
	rename: { subcommand: "rename", name: "DEPLOY_KEY", newName: "RENAMED_KEY" },
	value: { subcommand: "value", name: "DEPLOY_KEY", value: REPLACEMENT },
	scope: { subcommand: "scope", name: "DEPLOY_KEY", scope: "global" },
	copy: { subcommand: "copy", name: "DEPLOY_KEY" },
	extend: { subcommand: "extend", name: "DEPLOY_KEY", ttl: 7 * DAY },
	log: { subcommand: "log" },
	discard: { subcommand: "discard", scope: "project" },
	help: { subcommand: "help" },
};

describe("no verb hands a credential back to the surface", () => {
	for (const [subcommand, request] of Object.entries(REQUESTS) as [SecretSubcommand, SecretCommandRequest][]) {
		it(`keeps every stored byte out of what ${subcommand} reports`, async () => {
			const { vault, cleanup } = await vaultHolding("profile");
			try {
				// A verb that refuses is still covered: the refusal is a string on the same screen, and
				// `discard` on a readable vault is one of the two that always takes that path.
				const reported = await runSecretCommand(request, contextFor(vault)).then(
					result => [result.message, result.copyText ?? "", result.agentNotice ?? ""].join("\n"),
					(error: unknown) => (error instanceof Error ? error.message : String(error)),
				);

				for (const secret of [STORED, REPLACEMENT, ADDED]) expect(reported).not.toContain(secret);
			} finally {
				await cleanup();
			}
		});
	}
});
