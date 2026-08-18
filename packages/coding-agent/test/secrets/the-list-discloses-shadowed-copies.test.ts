import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseSecretCommand, renderSecretList, runSecretCommand } from "@veyyon/coding-agent/secrets/secret-command";
import { type ScopedVaultEntry, SecretVault } from "@veyyon/coding-agent/secrets/vault";

/**
 * `/secret list` names the stored copies that are held under a name resolving to a different one.
 *
 * WHY THIS SUITE EXISTS. Scopes shadow each other: project overrides profile, which overrides
 * global. The table is one row per NAME, because one row per name is what the agent can spend, and
 * that is correct. What it cost was any mention of the copies underneath. A credential stored in
 * two scopes appeared once, and the outer copy was invisible: still on disk, still decryptable,
 * and still able to become live the moment the copy in front of it was removed.
 *
 * That made the discovery order exactly backwards. An operator revoking a name learned a second
 * copy existed from the removal itself, at the moment it started being spent, rather than from the
 * list they consulted first. "What do I have stored" is the question `/secret list` exists to
 * answer, and a stored credential it declined to mention is the one answer it must not omit.
 *
 * WHAT IS ASSERTED. That the note appears only when a name really is held twice, so an ordinary
 * vault gains no noise; that the shadowed copy is disclosed WITHOUT being given a table row, since
 * a row in the spendable list that cannot be spent recreates the confusion in the other direction;
 * that the count keeps meaning "spendable"; and that the command the note prints actually removes
 * that copy, which is the part a text assertion alone would never catch.
 */

const NOW = Date.parse("2026-07-31T12:00:00Z");
const DAY = 86_400_000;

/** A stored entry, spelled out so each test states only the scope and name under test. */
function entry(name: string, scope: ScopedVaultEntry["scope"]): ScopedVaultEntry {
	return { name, scope, value: `value-of-${name}-${scope}`, createdAt: NOW, expiresAt: NOW + DAY };
}

describe("the shadow note", () => {
	/**
	 * NEGATIVE CONTROL, and the one that keeps this feature from becoming noise.
	 *
	 * Every name resolving to the only copy of itself is the ordinary vault, and it must read
	 * exactly as it did before. A note that appears when nothing is shadowed would train an operator
	 * to skip the line in the case that matters.
	 */
	it("says nothing when no name is held in more than one scope", () => {
		const entries = [entry("ALPHA_TOKEN", "project"), entry("BETA_TOKEN", "profile")];

		const rendered = renderSecretList(entries, { now: NOW, everywhere: entries });

		expect(rendered).not.toContain("also stored");
		expect(rendered).not.toContain("shadowed");
	});

	/**
	 * The disclosure itself, pinned as the exact line.
	 *
	 * Asserted byte for byte rather than by keyword because every clause is load-bearing: which
	 * scope holds the hidden copy, which copy is actually being spent, and the command that reaches
	 * the hidden one. A `toContain("shadowed")` would pass on a sentence that named the wrong scope,
	 * which is worse than saying nothing, since the operator would then remove the copy in effect.
	 */
	it("names the scope holding the hidden copy, the copy in effect, and how to remove it", () => {
		const effective = [entry("SHARED_TOKEN", "project")];
		const everywhere = [entry("SHARED_TOKEN", "project"), entry("SHARED_TOKEN", "global")];

		const lines = renderSecretList(effective, { now: NOW, everywhere }).split("\n");

		expect(lines.slice(-2)).toEqual([
			"  #SHARED_TOKEN# is also stored in the global vault, shadowed by the project one.",
			"  Only the project copy is spent. Remove it with /secret rm SHARED_TOKEN global.",
		]);
		// The note owns its own line breaks, like the unreadable-vault footer beside it. As one
		// sentence it ran past 150 columns and the terminal broke it mid-word.
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(96);
	});

	/**
	 * The hidden copy is disclosed in prose and NOT given a row, and the count still means spendable.
	 *
	 * This is the boundary the design turns on. Listing the shadowed copy as a row would be the
	 * obvious way to make it visible and would put an entry in the spendable table that cannot be
	 * spent, so `2 active secrets` would stop matching what the agent can do. One row per name and a
	 * sentence underneath keeps both facts true at once.
	 */
	it("keeps the table one row per name and the count on what can be spent", () => {
		const effective = [entry("SHARED_TOKEN", "project")];
		const everywhere = [entry("SHARED_TOKEN", "project"), entry("SHARED_TOKEN", "global")];

		const lines = renderSecretList(effective, { now: NOW, everywhere }).split("\n");
		const rows = lines.filter(line => line.includes("#SHARED_TOKEN#") && !line.includes("also stored"));

		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("project");
		expect(lines[0]).toStartWith("1 active secret.");
	});

	/**
	 * Two copies under one name produce two lines, each naming its own scope.
	 *
	 * The plural case is where a single summarising sentence ("this name is stored more than once")
	 * would have been tempting and useless: the operator needs the scope of each copy to remove it,
	 * and both removals are separate commands. Both lines must also agree on which copy is in
	 * effect, since that is the one neither of them should tell you to remove.
	 */
	it("reports every hidden copy when a name is held in all three scopes", () => {
		const effective = [entry("TRIPLE_TOKEN", "project")];
		const everywhere = [
			entry("TRIPLE_TOKEN", "project"),
			entry("TRIPLE_TOKEN", "profile"),
			entry("TRIPLE_TOKEN", "global"),
		];

		const lines = renderSecretList(effective, { now: NOW, everywhere }).split("\n");

		// Two hidden copies, two lines each, and each pair names its own scope in both halves. The
		// pairing is the part worth asserting as a block: a bug that emitted the right sentences with
		// the wrong scope in the second line would leave the operator removing the wrong credential.
		expect(lines.slice(-4)).toEqual([
			"  #TRIPLE_TOKEN# is also stored in the profile vault, shadowed by the project one.",
			"  Only the project copy is spent. Remove it with /secret rm TRIPLE_TOKEN profile.",
			"  #TRIPLE_TOKEN# is also stored in the global vault, shadowed by the project one.",
			"  Only the project copy is spent. Remove it with /secret rm TRIPLE_TOKEN global.",
		]);
	});

	/**
	 * A name whose only copy is in a wide scope is not a shadowed copy.
	 *
	 * Guards the comparison itself. Matching on "this entry's scope is not project" rather than on
	 * "another copy of this name won" would flag every global-only secret in the vault, which is the
	 * shape of bug that makes a warning worthless by firing constantly.
	 */
	it("does not flag a secret merely for living in a wide scope", () => {
		const entries = [entry("GLOBAL_ONLY", "global")];

		expect(renderSecretList(entries, { now: NOW, everywhere: entries })).not.toContain("also stored");
	});

	/**
	 * The shadow note and the unreadable-vault caveat coexist, in that order.
	 *
	 * These are the list's two footers and they answer different questions: one says a credential you
	 * own is not the one being spent, the other says part of the vault could not be read at all. A
	 * vault can be in both states at once, and the order matters because the caveat is the weaker
	 * claim: it ends the output with "some of this answer is missing", which is the right last word.
	 * Pinned because the two were written months apart and nothing else asserts they compose rather
	 * than one replacing the other.
	 */
	it("sits above the unreadable-vault caveat when a vault is both shadowed and broken", () => {
		const effective = [entry("SHARED_TOKEN", "profile")];
		const everywhere = [entry("SHARED_TOKEN", "profile"), entry("SHARED_TOKEN", "global")];

		const lines = renderSecretList(effective, { now: NOW, everywhere, unreadable: ["project"] }).split("\n");
		const shadow = lines.findIndex(line => line.includes("also stored"));
		const caveat = lines.findIndex(line => line.includes("could not be read"));

		expect(shadow).toBeGreaterThan(0);
		expect(caveat).toBeGreaterThan(shadow);
	});
});

describe("the command the note prints", () => {
	/**
	 * THE ADVICE IS EXECUTABLE, and this is the only test here that can prove it.
	 *
	 * Every other assertion in this file checks that a sentence is written correctly. None of them
	 * would notice if the command in that sentence were refused by the parser, named a scope the
	 * remover ignored, or took the copy in effect instead of the hidden one. That last case is the
	 * dangerous one: the operator would follow the list's own instructions and destroy the working
	 * credential while the hidden copy silently took over. So the command is lifted out of the
	 * rendered text and run, and the vault is checked afterwards.
	 */
	it("removes the hidden copy and leaves the one in effect alone", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-shadow-list-"));
		try {
			const vault = new SecretVault(
				{
					globalConfigRoot: path.join(root, "config"),
					profileDir: path.join(root, "config", "profiles", "work", "agent"),
					projectDir: path.join(root, "project", ".veyyon"),
				},
				() => NOW,
			);
			await vault.add({ name: "SHARED_TOKEN", value: "the-project-one", scope: "project" });
			await vault.add({ name: "SHARED_TOKEN", value: "the-global-one", scope: "global" });

			const rendered = renderSecretList(await vault.load(), {
				now: NOW,
				everywhere: await vault.loadEverywhere(),
			});
			const printed = rendered.match(/Remove it with (\/secret [^.]+)\./)?.[1];
			expect(printed).toBe("/secret rm SHARED_TOKEN global");

			// Run exactly what was printed, through the same parser an operator's typing would reach.
			await runSecretCommand(parseSecretCommand((printed as string).replace("/secret ", ""), "noninteractive"), {
				vault,
				readEnv: () => undefined,
				defaultTtl: 7 * DAY,
				now: NOW,
			});

			const left = await vault.loadEverywhere();
			expect(left).toHaveLength(1);
			expect(left[0]).toMatchObject({ scope: "project", value: "the-project-one" });

			// And the list stops mentioning a copy that is no longer there.
			expect(
				renderSecretList(await vault.load(), { now: NOW, everywhere: await vault.loadEverywhere() }),
			).not.toContain("also stored");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
