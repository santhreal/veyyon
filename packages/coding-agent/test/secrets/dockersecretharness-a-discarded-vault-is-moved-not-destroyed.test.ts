/**
 * `/secret discard`, the in-product repair for a vault file that exists and cannot be read.
 *
 * WHY THIS SUITE EXISTS. `load()` degrades past an unreadable scope with a notice and `remove()`
 * refuses to touch one, so before this verb the operator could start and could not fix: the vault
 * method existed and nothing called it, and the only real route was deleting the file by hand. The
 * rows here pin the two halves of that repair being safe.
 *
 * THE ROW THAT DEFENDS THE DESIGN is the byte comparison. The discard MOVES the file rather than
 * deleting it, because that file still holds real credentials sealed with a key that is still on
 * disk, so the damage may be a truncated tail with recoverable entries behind it. Destroying it to
 * make the product usable again is a trade the operator never agreed to. Without an assertion on
 * the bytes at the new path, and on that path being reported, a later simplification to `unlink`
 * passes review and silently converts a recoverable fault into a permanent loss.
 *
 * THE OTHER HALF is what it must refuse: a scope that reads normally, a path that is also another
 * scope's vault, and a bare invocation with no scope. That last one is why `--scope` is required
 * here and defaulted everywhere else. Elsewhere it names where to PUT something and a wrong guess
 * costs a secret filed in the wrong place, which `/secret list` shows you. Here it selects a FILE
 * TO MOVE ASIDE, so a default would let `/secret discard` on its own move a WORKING vault out from
 * under the session.
 *
 * THE SURFACE IS NONINTERACTIVE THROUGHOUT, and that is not incidental. `discard` is a verb, and
 * verbs only exist where there is no field and no GUI to replace them: a terminal reads its whole
 * argument line as a credential, so `discard --scope profile` typed there is a value, not a
 * command. What the rows below pin — the move, the permissions, the refusals, the required scope —
 * is vault semantics reached through the one grammar that can still name it, which is the grammar
 * a `-p` run and an ACP client speak.
 *
 * The vault is real, on a temporary directory, so the seal, the scope files and the move are the
 * production ones. The unreadable state comes from the shared fixture rather than from writing
 * garbage: `load()` skips exactly one failure, a payload that cleared every provenance and
 * integrity check whose decrypted plaintext will not parse, while invalid outer JSON is refused
 * outright. A suite that induced it the other way would measure the refusing branch while passing.
 * That refusal no longer kills the session: it is absorbed where the secret runtime is assembled,
 * so the whole vault reads as unreadable and this command stays reachable to repair it. See
 * `a-session-starts-when-its-vault-cannot-be-read.test.ts`, which owns that boundary.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	parseSecretCommand,
	runSecretCommand,
	type SecretCommandRequest,
	type SecretCommandResult,
	type SecretCommandSurface,
	secretCommandUsage,
} from "@veyyon/coding-agent/secrets/secret-command";
import {
	SecretVault,
	VAULT_FILENAME,
	type VaultLocations,
	type VaultScope,
	vaultPathFor,
} from "@veyyon/coding-agent/secrets/vault";
import { makeScopeUnreadable } from "./stalevaultneverrefuses-corrupt-vault-fixture";

/** Fixed clock, so the moved-aside filename is the only random part of the repair. */
const NOW = 1_800_000_000_000;

const SURVIVING_NAME = "SURVIVING_TOKEN";
const SURVIVING_VALUE = "ghp_surviving_scope_credential_0001";
const DOOMED_NAME = "BROKEN_SCOPE_TOKEN";
const DOOMED_VALUE = "ghp_broken_scope_credential_0002";
const SECOND_DOOMED_NAME = "SECOND_BROKEN_TOKEN";
const SECOND_DOOMED_VALUE = "ghp_second_broken_credential_0003";
const RE_ADDED_NAME = "REPLACEMENT_TOKEN";
const RE_ADDED_VALUE = "ghp_replacement_credential_0004";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true })));
	roots.length = 0;
});

interface Fixture {
	readonly locations: VaultLocations;
	readonly vault: SecretVault;
	/** Every moved-aside file sitting beside a scope's vault, absolute and sorted. */
	movedAside(scope: VaultScope): Promise<string[]>;
	/**
	 * Run `/secret <args>` the way a surface does: parse for that surface, then dispatch.
	 *
	 * DEFAULTS TO `noninteractive`, because that is the surface `discard` lives on. A terminal has
	 * no verbs at all now — the argument line there IS a credential — so every row below that types
	 * `discard --scope profile` is describing the text grammar a `-p` run or an ACP client speaks.
	 */
	secret(args: string, surface?: SecretCommandSurface): Promise<SecretCommandResult>;
	/** Dispatch a request built by hand, as a client that never goes through the parser does. */
	run(request: SecretCommandRequest, surface?: SecretCommandSurface): Promise<SecretCommandResult>;
}

/**
 * A command context over a throwaway vault.
 *
 * `shareProfileWithGlobal` points two scopes at ONE file, which is a real configuration rather than
 * a contrivance: a profile dir that is the config root makes the profile and global vaults the same
 * path, and discarding either would take both.
 */
async function fixture(options?: { shareProfileWithGlobal?: boolean }): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-secret-discard-"));
	roots.push(root);
	const globalConfigRoot = path.join(root, "config");
	const locations: VaultLocations = {
		globalConfigRoot,
		profileDir:
			options?.shareProfileWithGlobal === true
				? globalConfigRoot
				: path.join(globalConfigRoot, "profiles", "work", "agent"),
		projectDir: path.join(root, "project", ".veyyon"),
	};
	const vault = new SecretVault(locations, () => NOW);
	const run = async (request: SecretCommandRequest, surface: SecretCommandSurface = "noninteractive") =>
		await runSecretCommand(request, {
			vault,
			readEnv: () => undefined,
			defaultTtl: null,
			now: NOW,
			surface,
		});
	return {
		locations,
		vault,
		movedAside: async scope => {
			const directory = path.dirname(vaultPathFor(locations, scope));
			const names = await fs.readdir(directory);
			return names
				.filter(name => name.startsWith(`${VAULT_FILENAME}.unreadable-`))
				.map(name => path.join(directory, name))
				.sort();
		},
		secret: async (args, surface = "noninteractive") => await run(parseSecretCommand(args, surface), surface),
		run,
	};
}

/**
 * Seal a real secret into `scope`, then leave that scope's file authenticated and unparseable.
 *
 * The write comes first because the fixture seals against the binding the loader will compute for an
 * existing vault; sealing against a path that never held one authenticates as tampering instead.
 */
async function breakScope(target: Fixture, scope: VaultScope, name: string, value: string): Promise<string> {
	await target.vault.add({ name, value, scope, ttl: null });
	return await makeScopeUnreadable(target.locations, scope);
}

async function exists(target: string): Promise<boolean> {
	return await fs.stat(target).then(
		() => true,
		() => false,
	);
}

/** The message a refusal carried, so a row can assert on it without a rejects-matcher per fragment. */
async function refusal(body: Promise<unknown>): Promise<string> {
	return await body.then(
		() => "",
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
}

/** The same, for a parse that throws synchronously, so a row can assert what a message does NOT say. */
function messageOf(body: () => unknown): string {
	try {
		body();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("Expected a refusal, but the call returned.");
}

describe("/secret discard", () => {
	/**
	 * THE ROW THAT DEFENDS THE MOVE. A `unlink` in place of the rename would pass every other row in
	 * this suite: the scope becomes usable, the message still reads sensibly, nothing throws. Only a
	 * byte comparison at the new path fails, and it has to, because the discarded file holds real
	 * credentials sealed with a key that is still on disk and may still be partly recoverable.
	 */
	it("moves the unreadable file aside, and the moved file still holds the original bytes", async () => {
		const f = await fixture();
		const broken = await breakScope(f, "profile", DOOMED_NAME, DOOMED_VALUE);
		const before = await fs.readFile(broken);

		const result = await f.secret("discard --scope profile");

		const moved = await f.movedAside("profile");
		expect(moved.length).toBe(1);
		expect(await fs.readFile(moved[0])).toEqual(before);
		expect({ originalPathStillThere: await exists(broken), changed: result.changed }).toEqual({
			originalPathStillThere: false,
			changed: true,
		});
	});

	/**
	 * The moved file is still a credential store, so it must keep owner-only permissions. A repair
	 * implemented as read-then-write rather than a rename would land the new file at the process
	 * umask, publishing the sealed vault to every account on the machine while the row above, which
	 * only compares content, stayed green.
	 */
	it("leaves the moved file readable by its owner alone", async () => {
		const f = await fixture();
		await breakScope(f, "profile", DOOMED_NAME, DOOMED_VALUE);

		await f.secret("discard --scope profile");

		const [moved] = await f.movedAside("profile");
		expect((await fs.stat(moved)).mode & 0o777).toBe(0o600);
	});

	/**
	 * The moved path is the operator's ONLY route back to the entries in that file, so a message that
	 * omitted it would make a recoverable move indistinguishable from a delete. The same message must
	 * not carry the credential the file holds: it is printed to a terminal and pasted into issues.
	 */
	it("names the path it moved the file to, and never the credential that file holds", async () => {
		const f = await fixture();
		await breakScope(f, "profile", DOOMED_NAME, DOOMED_VALUE);

		const result = await f.secret("discard --scope profile");

		const [moved] = await f.movedAside("profile");
		expect(result.message).toContain(moved);
		expect(result.message.includes(DOOMED_VALUE)).toBe(false);
	});

	/**
	 * Guard against the destructive misfire. The precondition is re-checked inside the vault under
	 * the lock rather than trusted from an earlier `load()`, so a file repaired between the notice
	 * and the command is refused instead of moved. Without this, `/secret discard --scope profile`
	 * typed at the wrong moment is a working vault moved out from under the session.
	 */
	it("refuses a scope that reads normally, and leaves that file exactly where it is", async () => {
		const f = await fixture();
		await f.vault.add({ name: SURVIVING_NAME, value: SURVIVING_VALUE, scope: "profile", ttl: null });
		const readable = vaultPathFor(f.locations, "profile");
		const before = await fs.readFile(readable);

		const message = await refusal(f.secret("discard --scope profile"));

		expect(message).toContain("reads normally");
		expect(await fs.readFile(readable)).toEqual(before);
		expect(await f.movedAside("profile")).toEqual([]);
	});

	/**
	 * Two scopes can resolve to one file, and a profile dir that is the config root does exactly
	 * that. Moving it aside as "the profile vault" would take the global vault with it, so the
	 * refusal has to name the other owner: an operator told only "cannot discard" would reach for
	 * `rm` on the file itself and lose both.
	 */
	it("refuses a scope whose file is another scope's vault too, naming that other scope", async () => {
		const f = await fixture({ shareProfileWithGlobal: true });
		const shared = await breakScope(f, "global", DOOMED_NAME, DOOMED_VALUE);
		const before = await fs.readFile(shared);

		const message = await refusal(f.secret("discard --scope profile"));

		expect(message).toContain("global");
		expect(await fs.readFile(shared)).toEqual(before);
		expect(await f.movedAside("global")).toEqual([]);
	});

	/**
	 * The repair must be surgical. A discard that reached every damaged scope, or that cleared the
	 * whole unreadable set rather than the one path it moved, would look identical here and would
	 * quietly move a second file the operator never named.
	 */
	it("repairs only the scope it names, leaving a second broken scope broken and present", async () => {
		const f = await fixture();
		await breakScope(f, "profile", DOOMED_NAME, DOOMED_VALUE);
		const stillBroken = await breakScope(f, "project", SECOND_DOOMED_NAME, SECOND_DOOMED_VALUE);
		const before = await fs.readFile(stillBroken);

		await f.secret("discard --scope profile");

		await f.vault.load();
		expect(f.vault.unreadableScopes()).toEqual(["project"]);
		expect(await fs.readFile(stillBroken)).toEqual(before);
		expect((await f.movedAside("profile")).length).toBe(1);
		expect(await f.movedAside("project")).toEqual([]);
	});

	/**
	 * The point of the repair is a usable scope, not a tidier directory. A move that left the loader
	 * still treating the scope as broken, or that left a stale unreadable record behind, would end
	 * with `/secret add --scope profile` refused for a file that is no longer there.
	 */
	it("leaves the discarded scope able to store secrets again", async () => {
		const f = await fixture();
		await breakScope(f, "profile", DOOMED_NAME, DOOMED_VALUE);
		await f.secret("discard --scope profile");

		await f.vault.add({ name: RE_ADDED_NAME, value: RE_ADDED_VALUE, scope: "profile", ttl: null });

		const reloaded = await new SecretVault(f.locations, () => NOW).load();
		expect(reloaded.map(entry => `${entry.name}@${entry.scope}`)).toEqual([`${RE_ADDED_NAME}@profile`]);
		expect(f.vault.unreadableScopes()).toEqual([]);
	});

	/**
	 * A bare `/secret discard` must refuse rather than default, and must say why, because the default
	 * everywhere else `--scope` appears is profile. Defaulting here would move a working profile
	 * vault aside on a command the operator typed to repair something else, and the refusal carries
	 * the usage so the missing flag is learnable from the failure.
	 */
	it("refuses a bare invocation rather than defaulting the scope", () => {
		expect(() => parseSecretCommand("discard", "noninteractive")).toThrow("There is no default");
		expect(() => parseSecretCommand("discard", "noninteractive")).toThrow("--scope profile|project|global");
	});

	/**
	 * The parser is not the only way in: ACP and other adapters build a request object directly, so
	 * the scope requirement has to hold at the dispatch too. A guard that lived only in the parser
	 * would let a programmatic caller reach the vault with no scope at all.
	 */
	it("refuses a hand-built request with no scope, and moves nothing", async () => {
		const f = await fixture();
		await breakScope(f, "profile", DOOMED_NAME, DOOMED_VALUE);

		const message = await refusal(f.run({ subcommand: "discard" }));

		expect(message).toContain("--scope");
		expect(await f.movedAside("profile")).toEqual([]);
	});

	/**
	 * `discard` names a whole scope's file, never one entry, so a bare word is a secret name in the
	 * wrong place. Accepting and ignoring it is the dangerous reading: `/secret discard MY_TOKEN`
	 * looks like it removed one secret and would in fact have moved every secret in that scope.
	 *
	 * The refusal must NOT repeat the word. This test asserted that it did, which pinned the echo in
	 * place: `refuseExtraWords` cannot tell a secret name from a secret value, so the same sentence
	 * that helpfully quoted a name here also quoted the credential in `/secret rm TOK sk-live-...`
	 * and wrote it to the scrollback and the saved transcript. Naming the position carries the same
	 * information without repeating anything the operator typed.
	 */
	it("refuses a secret name, because it names a scope's file and not an entry", async () => {
		const f = await fixture();
		await breakScope(f, "profile", DOOMED_NAME, DOOMED_VALUE);

		const parse = () => parseSecretCommand(`discard ${SURVIVING_NAME} --scope profile`, "noninteractive");
		expect(parse).toThrow("no arguments");
		expect(messageOf(parse)).not.toContain(SURVIVING_NAME);
		expect(await f.movedAside("profile")).toEqual([]);
	});

	/**
	 * The repair belongs to the noninteractive surface, and its help is the one that has to carry it.
	 * A broken vault is most likely to be met by a headless client, which cannot open a masked prompt
	 * or a manager screen and so takes the noninteractive help; a verb missing from that surface, or
	 * from its help, leaves those operators with no in-product route at all.
	 *
	 * The TUI help deliberately does NOT list it. That surface has no verbs to list: it offers
	 * `/secret manager`, and a `discard` line there would advertise a word a terminal now stores as
	 * a credential. Asserted, rather than left implied, because a `discard` line reappearing in the
	 * TUI text is exactly the drift that would teach an operator to type it.
	 */
	it("runs from the noninteractive surface, whose help is the only one that lists it", async () => {
		const f = await fixture();
		const broken = await breakScope(f, "profile", DOOMED_NAME, DOOMED_VALUE);

		const result = await f.secret("discard --scope profile", "noninteractive");

		expect({ moved: (await f.movedAside("profile")).length, originalPathStillThere: await exists(broken) }).toEqual({
			moved: 1,
			originalPathStillThere: false,
		});
		expect(result.message).toContain("profile");
		expect(secretCommandUsage("noninteractive")).toContain("/secret discard");
		expect(secretCommandUsage("tui")).not.toContain("discard");
		expect(secretCommandUsage("tui")).toContain("/secret manager");
	});

	/**
	 * Named the wrong scope, and there is nothing there. That has to read as nothing to do, not as a
	 * crash and not as a success: a missing file reported as discarded would send the operator
	 * looking for a moved-aside vault that was never written.
	 */
	it("says there is nothing to discard when the named scope has no vault file", async () => {
		const f = await fixture();
		await f.vault.add({ name: SURVIVING_NAME, value: SURVIVING_VALUE, scope: "profile", ttl: null });

		const message = await refusal(f.secret("discard --scope project"));

		expect(message).toContain("nothing to discard");
		expect(await exists(vaultPathFor(f.locations, "project"))).toBe(false);
	});

	/**
	 * NEGATIVE CONTROL for every row above. The move must be attributable to this verb alone, so the
	 * verbs that merely read past a broken scope must leave it untouched. Without this, a `load()`
	 * that quarantined what it could not parse would satisfy the whole suite while relocating a
	 * credential file nobody asked it to touch.
	 */
	it("is the only verb that moves the file: reading past a broken scope leaves it alone", async () => {
		const f = await fixture();
		await f.vault.add({ name: SURVIVING_NAME, value: SURVIVING_VALUE, scope: "global", ttl: null });
		const broken = await breakScope(f, "profile", DOOMED_NAME, DOOMED_VALUE);
		const before = await fs.readFile(broken);

		const listed = await f.secret("list");
		await f.secret("help");

		expect(listed.message).toContain(`#${SURVIVING_NAME}#`);
		expect(listed.message.includes(SURVIVING_VALUE)).toBe(false);
		expect(await fs.readFile(broken)).toEqual(before);
		expect(await f.movedAside("profile")).toEqual([]);
	});
});
