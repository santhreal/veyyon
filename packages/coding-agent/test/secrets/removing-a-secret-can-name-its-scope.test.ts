import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseSecretCommand, runSecretCommand } from "@veyyon/coding-agent/secrets/secret-command";
import { SecretVault } from "@veyyon/coding-agent/secrets/vault";

/**
 * `/secret rm` can name the scope to remove from, and says which scope it searched when it finds
 * nothing.
 *
 * THE GAP THIS CLOSES. Scopes shadow each other: project overrides profile, which overrides
 * global. `SecretVault.remove` has always taken an optional scope, but the command refused the
 * `--scope` option outright, so every removal took the narrowest match. A name held in two scopes
 * therefore had its outer copy STRANDED. `/secret list` shows the resolved set, so the shadowed
 * entry was not even visible, and the only way to reach it was to remove the inner one first and
 * remember that the other existed. A credential you cannot see and cannot remove is the opposite
 * of what a vault is for.
 *
 * The usage text made it worse by advertising `--scope profile|project|global` under a heading
 * that claimed to apply to every subcommand, so the operator was told to pass a flag the parser
 * then rejected, which reads as a bug rather than as a limit.
 *
 * WHAT IS ASSERTED. That the option is accepted and TARGETS the named scope rather than being
 * parsed and ignored, which is the failure mode a test asserting only "it did not throw" would
 * miss; that the default is unchanged, because narrowest-first is the entry in effect and is what
 * an operator means almost every time; and that a miss names the scope it searched.
 */

const VALUE_PROJECT = "project-secret-value-0001";
const VALUE_GLOBAL = "global-secret-value-00002";
const VALUE_PROFILE = "profile-secret-value-0003";

interface Harness {
	vault: SecretVault;
	context: { vault: SecretVault; readEnv: (name: string) => string | undefined; defaultTtl: number; now: number };
	cleanup: () => Promise<void>;
}

async function harness(): Promise<Harness> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-rm-scope-"));
	const now = Date.parse("2026-07-31T12:00:00Z");
	const vault = new SecretVault(
		{
			globalConfigRoot: path.join(root, "config"),
			profileDir: path.join(root, "config", "profiles", "work", "agent"),
			projectDir: path.join(root, "project", ".veyyon"),
		},
		() => now,
	);
	return {
		vault,
		context: { vault, readEnv: () => undefined, defaultTtl: 7 * 86_400_000, now },
		cleanup: () => fs.rm(root, { recursive: true, force: true }),
	};
}

/** The shadowed state the gap was about: one name, two scopes, the outer one invisible to `list`. */
async function storeInBothScopes(vault: SecretVault): Promise<void> {
	await vault.add({ name: "DUPED_TOKEN", value: VALUE_PROJECT, scope: "project" });
	await vault.add({ name: "DUPED_TOKEN", value: VALUE_GLOBAL, scope: "global" });
}

async function remove(h: Harness, line: string): Promise<string> {
	const result = await runSecretCommand(parseSecretCommand(line, "noninteractive"), h.context);
	return result.message;
}

describe("removing a secret held in more than one scope", () => {
	/**
	 * The stranded-copy case, end to end. Before `--scope` was accepted this line was refused by the
	 * parser, so the global entry could not be removed at all while the project one existed.
	 *
	 * Both halves matter. Removing the global copy proves the option is honoured, and the project
	 * copy surviving proves it TARGETED rather than merely removing the usual narrowest match and
	 * reporting the scope it was handed.
	 */
	it("removes the named scope and leaves the other copy alone", async () => {
		const h = await harness();
		try {
			await storeInBothScopes(h.vault);

			expect(await remove(h, "rm DUPED_TOKEN --scope global")).toBe(
				"Removed DUPED_TOKEN from the global vault. It was shadowed by the project secret of the same " +
					"name, so #DUPED_TOKEN# spends what it spent before.",
			);

			// `load()` resolves by precedence, so it shows one row per name and cannot by itself prove
			// which scope was removed. Probing each scope directly is what distinguishes "removed the
			// global copy" from "removed the project copy and reported global".
			const left = await h.vault.load();
			const remaining = left.filter(entry => entry.name === "DUPED_TOKEN");
			expect(remaining).toHaveLength(1);
			expect(remaining[0]?.scope).toBe("project");
			expect(await h.vault.remove("DUPED_TOKEN", "global")).toBeNull();
			expect(await h.vault.remove("DUPED_TOKEN", "project")).toBe("project");
		} finally {
			await h.cleanup();
		}
	});

	/**
	 * The default is deliberately unchanged: no scope means the narrowest match, which is the entry
	 * actually in effect. Adding the option must not have quietly turned removal into something that
	 * needs a scope, nor changed which copy an unqualified removal takes.
	 */
	it("still takes the narrowest match when no scope is named", async () => {
		const h = await harness();
		try {
			await storeInBothScopes(h.vault);

			expect(await remove(h, "rm DUPED_TOKEN")).toContain("Removed DUPED_TOKEN from the project vault.");
			// The project copy is gone, so the global one is no longer shadowed and surfaces here.
			const left = await h.vault.load();
			const remaining = left.filter(entry => entry.name === "DUPED_TOKEN");
			expect(remaining).toHaveLength(1);
			expect(remaining[0]?.scope).toBe("global");
		} finally {
			await h.cleanup();
		}
	});

	/**
	 * A miss has to say WHERE it looked. "No secret named X is stored" is false when X is sitting in
	 * another vault, and it reads as "it is already gone", which is the one conclusion that stops
	 * the operator looking for the copy that is still in effect.
	 */
	it("names the scope it searched when the secret is not in it", async () => {
		const h = await harness();
		try {
			await h.vault.add({ name: "DUPED_TOKEN", value: VALUE_PROFILE, scope: "profile" });

			await expect(remove(h, "rm DUPED_TOKEN --scope global")).rejects.toThrow(
				"No secret named DUPED_TOKEN is stored in the global vault. Run /secret list to see what is.",
			);

			// The refusal must not have removed the copy that does exist.
			const left = await h.vault.load();
			expect(left.filter(entry => entry.name === "DUPED_TOKEN")).toHaveLength(1);
		} finally {
			await h.cleanup();
		}
	});

	/**
	 * With no scope named, the message stays the shorter unqualified one. The two wordings are
	 * generated from the same branch, so this is what stops a change to the scoped text from
	 * leaking "in the undefined vault" into the ordinary case.
	 */
	it("keeps the unqualified wording when no scope was named", async () => {
		const h = await harness();
		try {
			await expect(remove(h, "rm ABSENT_TOKEN")).rejects.toThrow(
				"No secret named ABSENT_TOKEN is stored. Run /secret list to see what is.",
			);
		} finally {
			await h.cleanup();
		}
	});
});

describe("the usage text for removal", () => {
	/**
	 * The help has to agree with the parser. The footer used to advertise `--scope` as applying to
	 * every subcommand while `rm` refused it, and a flag that is documented and then rejected costs
	 * more than one that is simply absent: the operator assumes the failure is theirs.
	 *
	 * Asserted through the parser rather than by reading the help string, so this proves the
	 * capability the help claims, not that two strings happen to match.
	 */
	it("accepts every scope the help offers", async () => {
		for (const scope of ["profile", "project", "global"] as const) {
			const parsed = parseSecretCommand(`rm SOME_TOKEN --scope ${scope}`, "noninteractive");
			expect(parsed.subcommand).toBe("rm");
			expect(parsed.scope).toBe(scope);
			expect(parsed.name).toBe("SOME_TOKEN");
		}
	});
});

describe("removing a secret that has another copy underneath it", () => {
	/**
	 * A REMOVAL THAT UNCOVERS ANOTHER COPY IS NOT A REVOCATION, and must not be reported as one.
	 *
	 * Scopes shadow each other, so removing the copy in effect can leave a second one live under the
	 * same name. The command used to answer this with a flat "Removed X from the project vault." and
	 * a notice telling the model the secret was revoked, `#X#` was dead, and writing it would send
	 * literal text. Every part of that was false: `#X#` still expanded, to a DIFFERENT credential.
	 *
	 * The cost is not cosmetic. The operator believes a credential is gone while the placeholder
	 * goes on spending one, and the next use authenticates as a different identity with nothing on
	 * screen saying so. `list` resolves by precedence and never showed the second copy either, so
	 * the state was invisible from both sides. This is the test that keeps it visible.
	 */
	it("says the placeholder now spends the copy underneath, and does not claim a revocation", async () => {
		const h = await harness();
		try {
			await storeInBothScopes(h.vault);

			const result = await runSecretCommand(parseSecretCommand("rm DUPED_TOKEN", "noninteractive"), h.context);

			expect(result.message).toBe(
				"Removed DUPED_TOKEN from the project vault. A global secret of the same name was underneath it, " +
					"so #DUPED_TOKEN# still spends a credential, now that one. " +
					"Run /secret rm DUPED_TOKEN --scope global to remove that one too.",
			);
			// The flag is what a session uses to treat a name as dead. Setting it here would have the
			// runtime refuse a placeholder that still resolves.
			expect(result.agentNoticeIsRevocation).toBeUndefined();
			expect(result.agentNotice).toContain("now refers to a different stored credential");
			expect(result.agentNotice).not.toContain("no longer available");
			expect(result.agentNotice).not.toContain("sends the literal");

			// The uncovered credential is genuinely still spendable, which is the fact the wording
			// now reports. Asserting the VALUE is what distinguishes "a row remains" from "the
			// placeholder resolves to a different secret".
			const live = (await h.vault.load()).find(entry => entry.name === "DUPED_TOKEN");
			expect(live?.scope).toBe("global");
			expect(live?.value).toBe(VALUE_GLOBAL);
		} finally {
			await h.cleanup();
		}
	});

	/**
	 * The ordinary removal keeps its revocation notice untouched. Without this the fix above could
	 * be satisfied by never reporting a revocation at all, which would leave a model happily writing
	 * a placeholder that no longer expands.
	 */
	it("still reports a real revocation when nothing is left underneath", async () => {
		const h = await harness();
		try {
			await h.vault.add({ name: "DUPED_TOKEN", value: VALUE_PROFILE, scope: "profile" });

			const result = await runSecretCommand(parseSecretCommand("rm DUPED_TOKEN", "noninteractive"), h.context);

			expect(result.message).toBe("Removed DUPED_TOKEN from the profile vault.");
			expect(result.agentNoticeIsRevocation).toBe(true);
			expect(result.agentNotice).toContain("no longer available");
			expect(await h.vault.load()).toHaveLength(0);
		} finally {
			await h.cleanup();
		}
	});

	/**
	 * Removing the OUTER copy leaves the inner one in effect, which was already true before the
	 * removal, so the placeholder's meaning does not change and the message must not imply it did.
	 * This is the case most likely to be broken by a fix that only looks at "does the name still
	 * resolve" without asking whether anything actually changed for the operator.
	 */
	it("reports the uncovered copy only when the removal changed what the placeholder spends", async () => {
		const h = await harness();
		try {
			await storeInBothScopes(h.vault);

			const result = await runSecretCommand(
				parseSecretCommand("rm DUPED_TOKEN --scope global", "noninteractive"),
				h.context,
			);

			// Asserted as an exact string. An earlier version of this test used `toContain` on the
			// first sentence, which passed while the command was wrongly appending the "now spends
			// that one" wording to a removal that changed nothing. A prefix assertion cannot catch a
			// message that says too much.
			expect(result.message).toBe(
				"Removed DUPED_TOKEN from the global vault. It was shadowed by the project secret of the same " +
					"name, so #DUPED_TOKEN# spends what it spent before.",
			);
			expect(result.agentNotice).toBeUndefined();
			expect(result.agentNoticeIsRevocation).toBeUndefined();

			// The project copy was in effect before and after, so this is an ordinary removal of a
			// credential that was never being spent under this placeholder.
			const live = (await h.vault.load()).find(entry => entry.name === "DUPED_TOKEN");
			expect(live?.value).toBe(VALUE_PROJECT);
		} finally {
			await h.cleanup();
		}
	});
});
