/**
 * WHY THIS EXISTS.
 *
 * `/secret` had no way to empty a vault, and every word an operator reaches for to do it was
 * unreserved. The parser's documented fallback was then "an unreserved first word is a credential" —
 * since replaced by requiring a command first — so
 * `/secret clear` did not fail: it STORED the six-character string `clear` under a generated name,
 * `/secret clear --all` stored the literal `clear --all`, and because the first successful `add`
 * also switches `secrets.enabled` on, the command typed to empty the vault filled it and turned the
 * subsystem on. Measured before the fix: `clear`, `wipe`, `purge`, `reset` and `empty` all parsed as
 * `subcommand=add` with the word itself as the value.
 *
 * THE CLASS, not the incident. The incident is the word `clear`. The class is "a word that means
 * emptying the vault is silently a credential", and it has one more member every time somebody
 * thinks of a synonym. So the sweep below derives the vocabulary from the parser's own table at run
 * time and asserts that NO spelling of this idea parses as `add`, rather than pinning the five
 * spellings that happened to be reported.
 *
 * WHAT IT DOES NOT CATCH. It does not prove the vault file on disk is rewritten -- that is
 * `SecretVault.clear`'s own suite below it in this file, which drives a real vault in a temp home.
 * It says nothing about the OTHER unreserved words that are still credentials by design (a token
 * beginning `ghp_` must keep storing), and it cannot know a synonym nobody has thought of: the
 * `EMPTYING_WORDS` list is the fence, and the run-time sweep only guarantees every word ON it stays
 * a command.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	parseSecretCommand,
	runSecretCommand,
	SECRET_SUBCOMMAND_SHAPES,
	SECRET_TUI_SUBCOMMANDS,
	SECRET_VERB_SPELLINGS,
} from "../../src/secrets/secret-command";
import { resolveVaultLocations, SecretVault } from "../../src/secrets/vault";
import { useTrackedTempDirFactory } from "../helpers/tracked-temp-dir";

const tempDir = useTrackedTempDirFactory();

/**
 * Every spelling this product promises is a command rather than a credential.
 *
 * Written down here because a synonym cannot be derived from anything: it is a claim about what an
 * operator will type. Each one is then checked against the live parser, so adding a word here
 * without reserving it fails, and reserving one without listing it is caught by the reverse sweep.
 */
const EMPTYING_WORDS = ["clear", "wipe", "purge", "empty", "reset"] as const;

/** A vault over three scope directories under one throwaway home. */
function vaultAt(home: string): SecretVault {
	return new SecretVault(
		resolveVaultLocations({
			cwd: path.join(home, "project"),
			agentDir: path.join(home, "agent"),
			globalConfigRoot: path.join(home, "global"),
		}),
	);
}

describe("a word that means emptying the vault is never stored as a credential", () => {
	for (const word of EMPTYING_WORDS) {
		it(`/secret ${word} profile runs the clear command`, () => {
			const parsed = parseSecretCommand(`${word} profile`);
			expect(parsed.subcommand).toBe("clear");
			expect(parsed.scope).toBe("profile");
			// The defect was not "wrong subcommand", it was "the word became a value". Assert the
			// absence directly: a grammar that routed to `clear` while also keeping the word as a
			// credential would satisfy the line above and still store it.
			expect(parsed.value).toBeUndefined();
		});

		it(`/secret ${word} on its own refuses instead of storing the word`, () => {
			// THE ORIGINAL DEFECT, stated as the assertion that would have caught it: before `clear`
			// was a command this line parsed to `{subcommand: "add", value: "<word>"}` and filed the
			// word as a credential. Now it names the word it still needs. Both halves are asserted,
			// because a refusal for the wrong reason (an unknown command, say) would leave the class
			// open on the next synonym.
			let thrown: Error | undefined;
			try {
				parseSecretCommand(word);
			} catch (error) {
				thrown = error as Error;
			}
			expect(thrown).toBeDefined();
			expect(thrown?.message).toContain("needs the vault to empty");
			expect(thrown?.message).toContain("There is no default");
			expect(thrown?.message).toContain("/secret clear");
		});
	}

	it("every reserved spelling of clear is one the vocabulary above declares", () => {
		const reserved = Object.entries(SECRET_VERB_SPELLINGS)
			.filter(([, subcommand]) => subcommand === "clear")
			.map(([word]) => word)
			.sort();
		// Exact equality, not a superset check: a sixth spelling reserved without a line in
		// EMPTYING_WORDS is a word this suite is not sweeping, which is how the class reopens.
		expect(reserved).toEqual([...EMPTYING_WORDS].sort());
	});

	it("reads one word, the vault, so a name after it cannot be read as one secret to remove", () => {
		// A vault and nothing else: the word is required, so `clear` can never be given a secret name
		// and quietly empty the whole vault the name lived in.
		expect(SECRET_SUBCOMMAND_SHAPES.clear.slots).toEqual(["scope"]);
		expect(SECRET_SUBCOMMAND_SHAPES.clear.required).toBe(1);
		expect(SECRET_SUBCOMMAND_SHAPES.clear.trailing).toEqual([]);
		expect(SECRET_SUBCOMMAND_SHAPES.clear.needsScope).toBe(true);
		expect(() => parseSecretCommand("clear profile MY_TOKEN")).toThrow();
		// A name in the vault's own position is refused too, rather than resolving to a default vault.
		expect(() => parseSecretCommand("clear MY_TOKEN")).toThrow();
	});

	it("is offered by the completion menu, so it is discoverable without reading source", () => {
		const offered = SECRET_TUI_SUBCOMMANDS.find(sub => sub.name === "clear");
		expect(offered).toBeDefined();
		expect(offered?.usage).toBe("profile");
	});
});

describe("clearing one vault reports what it did to every placeholder it held", () => {
	async function seeded(home: string): Promise<SecretVault> {
		const store = vaultAt(home);
		await store.add({ name: "ALPHA", value: "alpha-value", scope: "profile", ttl: null });
		await store.add({ name: "BRAVO", value: "beta-value", scope: "profile", ttl: null });
		return store;
	}

	it("empties the scope it was given and names what it removed", async () => {
		const home = tempDir("veyyon-vault-clear-");
		const store = await seeded(home);
		const removed = await store.clear("profile");
		expect([...removed].sort()).toEqual(["ALPHA", "BRAVO"]);
		expect(await store.load()).toEqual([]);
	});

	it("is one transaction, so a second clear finds nothing rather than reporting again", async () => {
		const home = tempDir("veyyon-vault-clear-twice-");
		const store = await seeded(home);
		await store.clear("profile");
		expect(await store.clear("profile")).toEqual([]);
	});

	it("drops an expired entry from the file without naming it in the report", async () => {
		// WHY: the report is what an operator reads to decide whether the credential they were
		// worried about is gone. An expired entry can no longer expand, so naming it pads that
		// report with a credential the session had already stopped honouring -- while leaving it
		// on disk would make a "cleared" vault non-empty. Both halves are asserted, because the
		// tempting simplification (report `current` instead of the live subset) satisfies the
		// on-disk half on its own.
		const home = tempDir("veyyon-vault-clear-expired-");
		let clock = 1_000;
		const store = new SecretVault(
			resolveVaultLocations({
				cwd: path.join(home, "project"),
				agentDir: path.join(home, "agent"),
				globalConfigRoot: path.join(home, "global"),
			}),
			() => clock,
		);
		await store.add({ name: "ALPHA", value: "alpha-value", scope: "profile", ttl: null });
		// A lifetime is milliseconds, so this entry is dead one second after the clock moves.
		await store.add({ name: "SHORT_LIVED", value: "short-value", scope: "profile", ttl: 60_000 });
		clock = 1_000 + 61_000;
		expect(await store.clear("profile")).toEqual(["ALPHA"]);
		expect(await store.load()).toEqual([]);
	});

	it("leaves the other scopes alone", async () => {
		const home = tempDir("veyyon-vault-clear-scoped-");
		const store = await seeded(home);
		await store.add({ name: "GLOBAL_ONLY", value: "global-value", scope: "global", ttl: null });
		await store.clear("profile");
		const left = await store.load();
		expect(left.map(entry => entry.name)).toEqual(["GLOBAL_ONLY"]);
	});

	it("does not call a shadowed name revoked, because its placeholder still spends a credential", async () => {
		const home = tempDir("veyyon-vault-clear-shadow-");
		const store = await seeded(home);
		// The same name in a wider vault: `load()` resolves narrowest-first, so clearing profile
		// leaves #ALPHA# expanding to the global copy.
		await store.add({ name: "ALPHA", value: "global-alpha", scope: "global", ttl: null });
		const result = await runSecretCommand(parseSecretCommand("clear profile"), {
			vault: store,
			readEnv: () => undefined,
			defaultTtl: null,
			now: Date.now(),
		});
		expect(result.changed).toBe(true);
		expect(result.message).toContain("ALPHA");
		// BRAVO had nothing underneath it, so it IS revoked and the model must be told. ALPHA must not
		// appear in that notice: telling the model to stop writing a live placeholder is the failure
		// this assertion exists to prevent.
		expect(result.agentNotice).toContain("#BRAVO#");
		expect(result.agentNotice).not.toContain("#ALPHA#");
		expect(result.agentNoticeIsRevocation).toBe(true);
	});

	it("says nothing to the model when every cleared name still resolves elsewhere", async () => {
		const home = tempDir("veyyon-vault-clear-all-shadowed-");
		const store = vaultAt(home);
		await store.add({ name: "SOLO_KEY", value: "profile-value", scope: "profile", ttl: null });
		await store.add({ name: "SOLO_KEY", value: "global-value", scope: "global", ttl: null });
		const result = await runSecretCommand(parseSecretCommand("clear profile"), {
			vault: store,
			readEnv: () => undefined,
			defaultTtl: null,
			now: Date.now(),
		});
		expect(result.agentNotice).toBeUndefined();
		expect(result.agentNoticeIsRevocation).toBeUndefined();
	});

	it("reports an empty vault as nothing removed rather than as a change", async () => {
		const home = tempDir("veyyon-vault-clear-empty-");
		const store = vaultAt(home);
		const result = await runSecretCommand(parseSecretCommand("clear project"), {
			vault: store,
			readEnv: () => undefined,
			defaultTtl: null,
			now: Date.now(),
		});
		expect(result.changed).toBe(false);
		expect(result.message).toContain("no secrets");
	});
});
