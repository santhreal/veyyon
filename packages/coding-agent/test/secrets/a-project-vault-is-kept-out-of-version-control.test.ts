/**
 * A project-scope vault must not be committable.
 *
 * WHY THIS SUITE EXISTS. `project` is the one scope whose file lands inside the repository the
 * operator is working in, and nothing kept it out of their commits. A real `.veyyon/vault.json` was
 * found untracked in this repo, one `git add -A` away from being published. The vault is ciphertext
 * rather than plaintext, so the immediate harm is bounded, but a committed vault is a credential
 * store in the history that no clone can decrypt, which then breaks `/secret` for whoever cloned it.
 *
 * Every row asks GIT whether the vault is ignored, and stages a real `git add -A`, rather than
 * reading the generated `.gitignore` back and asserting on its text. Text can look right and not
 * ignore anything: the pattern that started this was `.veyyon/vault.json`, which is anchored to the
 * file it sits in and silently misses a vault in a subdirectory. Only git settles it.
 *
 * The scope-limiting row is the one that keeps the fix from being worse than the bug. A project
 * `.veyyon/` also holds things a repo is SUPPOSED to track, so ignoring the DIRECTORY would quietly
 * stop skills and project settings being committed and would read as git losing files.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SecretVault, VAULT_FILENAME, type VaultLocations, vaultPathFor } from "@veyyon/coding-agent/secrets/vault";
import { $ } from "bun";

const VALUE = "ghp_a_real_looking_token";

interface Repo {
	readonly root: string;
	readonly vault: SecretVault;
	readonly locations: VaultLocations;
	/** What git says about a path: true when it is ignored. */
	readonly ignored: (relative: string) => Promise<boolean>;
	/** What `git add -A` would actually stage. */
	readonly staged: () => Promise<string[]>;
	readonly ignoreFile: () => Promise<string>;
}

/** A real git repository with a vault pointed at its `.veyyon/`, since only git can answer this. */
async function withRepo(seedIgnore: string | undefined, body: (repo: Repo) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-project-ignore-"));
	try {
		const work = path.join(root, "repo");
		const projectDir = path.join(work, ".veyyon");
		await fs.mkdir(projectDir, { recursive: true });
		await $`git init -q`.cwd(work).quiet();
		if (seedIgnore !== undefined) await Bun.write(path.join(projectDir, ".gitignore"), seedIgnore);

		const locations: VaultLocations = {
			globalConfigRoot: path.join(root, "config"),
			profileDir: path.join(root, "config", "profiles", "work", "agent"),
			projectDir,
		};
		await fs.mkdir(locations.globalConfigRoot, { recursive: true, mode: 0o700 });

		await body({
			root: work,
			vault: new SecretVault(locations, () => 1_800_000_000_000),
			locations,
			ignored: async relative =>
				(await $`git check-ignore -q ${relative}`.cwd(work).quiet().nothrow()).exitCode === 0,
			staged: async () => {
				await $`git add -A`.cwd(work).quiet().nothrow();
				const listed = await $`git diff --cached --name-only`.cwd(work).quiet().nothrow();
				return listed
					.text()
					.split("\n")
					.map(line => line.trim())
					.filter(line => line.length > 0);
			},
			ignoreFile: () => Bun.file(path.join(projectDir, ".gitignore")).text(),
		});
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

describe("a project vault is kept out of version control", () => {
	/**
	 * THE ROW THAT DEFENDS THE FIX. Storing one project secret must leave the vault unstageable, and
	 * `git add -A` is the exact command that would have published it.
	 */
	it("leaves the vault ignored and unstaged after the first project secret", async () => {
		await withRepo(undefined, async repo => {
			await repo.vault.add({ name: "MY_TOKEN", value: VALUE, scope: "project" });

			expect(await repo.ignored(`.veyyon/${VAULT_FILENAME}`)).toBe(true);
			const staged = await repo.staged();
			expect(staged).not.toContain(`.veyyon/${VAULT_FILENAME}`);
			// The ignore file itself is the thing that SHOULD be committed, so it must be stageable.
			expect(staged).toContain(".veyyon/.gitignore");
		});
	});

	/**
	 * The sibling that stops this fix from breaking repos. Ignoring `.veyyon/` would take the skills
	 * and project settings a repo is meant to track with it, which looks like git dropping files.
	 */
	it("ignores only the vault, leaving the rest of .veyyon trackable", async () => {
		await withRepo(undefined, async repo => {
			await repo.vault.add({ name: "MY_TOKEN", value: VALUE, scope: "project" });
			await Bun.write(path.join(repo.root, ".veyyon", "skills", "demo", "SKILL.md"), "# demo\n");
			await Bun.write(path.join(repo.root, ".veyyon", "settings.json"), "{}\n");

			expect(await repo.ignored(".veyyon/skills/demo/SKILL.md")).toBe(false);
			expect(await repo.ignored(".veyyon/settings.json")).toBe(false);
			const staged = await repo.staged();
			expect(staged).toContain(".veyyon/skills/demo/SKILL.md");
			expect(staged).toContain(".veyyon/settings.json");
			expect(staged).not.toContain(`.veyyon/${VAULT_FILENAME}`);
		});
	});

	/**
	 * A vault also has to be unignorable-proof against the discard rename: `/secret discard` moves a
	 * broken vault to `vault.json.unreadable-<stamp>`, and that file still holds the sealed entries.
	 */
	it("ignores the file a discarded vault is renamed to", async () => {
		await withRepo(undefined, async repo => {
			await repo.vault.add({ name: "MY_TOKEN", value: VALUE, scope: "project" });
			const moved = `${vaultPathFor(repo.locations, "project")}.unreadable-2026-07-28T00-00-00-abcd`;
			await Bun.write(moved, "sealed");

			expect(await repo.ignored(path.relative(repo.root, moved))).toBe(true);
			expect(await repo.staged()).not.toContain(path.relative(repo.root, moved));
		});
	});

	/**
	 * THE UPGRADE PATH, and the case a create-only guard silently misses. A vault stored before this
	 * shipped sits in a directory that may already have a `.gitignore` for some other reason; a guard
	 * that only creates would leave that vault committable and say nothing.
	 */
	it("extends an existing ignore file that does not cover the vault", async () => {
		await withRepo("# notes only\n*.log\n", async repo => {
			await repo.vault.add({ name: "MY_TOKEN", value: VALUE, scope: "project" });

			expect(await repo.ignored(`.veyyon/${VAULT_FILENAME}`)).toBe(true);
			// The operator's own rule survives, because their file is appended to and never rewritten.
			const text = await repo.ignoreFile();
			expect(text).toContain("*.log");
			expect(text.startsWith("# notes only")).toBe(true);
		});
	});

	/** A file with no trailing newline must not have the first rule welded onto its last line. */
	it("appends cleanly to a file that does not end in a newline", async () => {
		await withRepo("*.log", async repo => {
			await repo.vault.add({ name: "MY_TOKEN", value: VALUE, scope: "project" });

			expect(await repo.ignored(`.veyyon/${VAULT_FILENAME}`)).toBe(true);
			expect(await repo.ignored(".veyyon/anything.log")).toBe(true);
			const lines = (await repo.ignoreFile()).split("\n").map(line => line.trim());
			expect(lines).toContain("*.log");
			expect(lines).toContain(VAULT_FILENAME);
		});
	});

	/**
	 * An ignore file that already names the vault is left exactly as it is. Rewriting or re-appending
	 * would edit a file in the operator's tree on every single `/secret add`.
	 */
	it("does not touch an ignore file that already covers the vault", async () => {
		const mine = "# mine, hands off\nvault.json\n";
		await withRepo(mine, async repo => {
			await repo.vault.add({ name: "MY_TOKEN", value: VALUE, scope: "project" });

			expect(await repo.ignoreFile()).toBe(mine);
			expect(await repo.ignored(`.veyyon/${VAULT_FILENAME}`)).toBe(true);
		});
	});

	/** Storing several project secrets must not accrete a copy of the block per call. */
	it("stays idempotent across repeated project writes", async () => {
		await withRepo("*.log", async repo => {
			for (const name of ["FIRST_TOKEN", "SECOND_TOKEN", "THIRD_TOKEN"]) {
				await repo.vault.add({ name, value: VALUE, scope: "project" });
			}

			const occurrences = (await repo.ignoreFile()).split("\n").filter(line => line.trim() === VAULT_FILENAME);
			expect(occurrences).toHaveLength(1);
		});
	});

	/**
	 * Scope-limited on purpose. A profile or global vault lives under the config root rather than in
	 * a repository, so writing a `.gitignore` beside it would be litter in a directory veyyon owns
	 * for a problem that scope does not have.
	 */
	it("writes no ignore file for a profile-scope vault", async () => {
		await withRepo(undefined, async repo => {
			await repo.vault.add({ name: "MY_TOKEN", value: VALUE, scope: "profile" });

			const beside = path.join(repo.locations.profileDir, ".gitignore");
			expect(await Bun.file(beside).exists()).toBe(false);
			expect(await Bun.file(path.join(repo.root, ".veyyon", ".gitignore")).exists()).toBe(false);
		});
	});

	/**
	 * A command that never stores anything must not leave a file in the operator's repository. The
	 * name floor rejects this before any write, and the guard sits on the write path so it stays put.
	 */
	it("leaves the repository untouched when the secret is refused", async () => {
		await withRepo(undefined, async repo => {
			await expect(repo.vault.add({ name: "NO", value: VALUE, scope: "project" })).rejects.toThrow();

			expect(await Bun.file(path.join(repo.root, ".veyyon", ".gitignore")).exists()).toBe(false);
		});
	});
});
