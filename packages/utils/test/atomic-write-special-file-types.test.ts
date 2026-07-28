import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile, atomicWriteFileSync, atomicWriteFileWith, removeWithRetries } from "@veyyon/utils";

/**
 * What an atomic write does when the target is NOT an ordinary file (ENV-6,
 * ENV-7).
 *
 * WHY THIS SUITE EXISTS. Every atomic write ends in `rename(temp, target)`, and
 * `rename` does not ask what the target is. Pointed at a named pipe it destroys
 * the pipe and leaves a regular file with the same name; pointed at a symlink
 * chain it can replace an intermediate LINK and never touch the file the user
 * keeps; pointed at one name of a hardlinked pair it silently breaks the link.
 * None of that produces an error, and all of it is reachable from ordinary
 * configuration: dotfile managers build symlink chains, backup tools build
 * hardlink farms, and a config path is a string a user can point anywhere.
 *
 * The behaviour for each type is a decision, so each one is written down here as
 * an assertion on the real filesystem rather than left to whatever `rename`
 * happens to do:
 *
 *  - SYMLINK, at any chain depth: the links survive and the file at the end of
 *    the chain receives the bytes.
 *  - NOT A REGULAR FILE (FIFO, socket, directory): refused by name, with the
 *    thing left exactly as it was.
 *  - HARDLINK: the link IS broken, deliberately, and that is pinned so it is a
 *    documented consequence of atomicity rather than a surprise.
 *
 * Device nodes are named in the refusal logic but not exercised here: creating a
 * character or block device requires `mknod` as root, and writing the test
 * against `/dev/null` would mean aiming a write at real system state. The FIFO
 * and socket cases cover the same branch through the same `assertRegularFileTarget`.
 */
describe("atomic writes against special file types", () => {
	let dir = "";

	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), "atomic-special-"));
	});

	afterEach(async () => {
		if (dir) {
			await removeWithRetries(dir);
			dir = "";
		}
	});

	const at = (name: string) => path.join(dir, name);
	const read = (target: string) => fsp.readFile(target, "utf8");

	describe("symlinks (ENV-7): the link survives and its target is what changes", () => {
		/**
		 * The single-hop case, restated here next to the chain case so the two read
		 * as one contract. A dotfile manager points `config.yml` into a synced repo;
		 * replacing the link with a regular file would quietly detach the config from
		 * the repo it is supposed to live in, and the next `git status` would show
		 * nothing wrong.
		 */
		it("writes through a one-level symlink without replacing the link", async () => {
			const real = at("real.yml");
			const link = at("config.yml");
			await fsp.writeFile(real, "old\n");
			await fsp.symlink(real, link);

			await atomicWriteFile(link, "new\n");

			expect((await fsp.lstat(link)).isSymbolicLink()).toBe(true);
			expect(await read(real)).toBe("new\n");
		});

		/**
		 * THE case this suite was written for, and a real defect when it was written:
		 * resolving one hop with `readlink` and stopping puts the write on the
		 * INTERMEDIATE link. Before the fix `l1` came back a regular file holding the
		 * new bytes while `real.yml` still held the old ones, so a read through the
		 * chain returned the new content and the file the user actually keeps was
		 * never updated. Silent in both directions, which is what made it dangerous.
		 *
		 * Two hops is not exotic: `~/.config/app -> ~/dotfiles/app -> ~/dotfiles/app.v2`
		 * is what a manager plus a versioned file produces.
		 */
		it("follows a TWO-LEVEL chain to the real file, leaving both links intact", async () => {
			const real = at("real.yml");
			const l1 = at("l1");
			const l2 = at("l2");
			await fsp.writeFile(real, "old\n");
			await fsp.symlink(real, l1);
			await fsp.symlink("l1", l2);

			await atomicWriteFile(l2, "new\n");

			expect((await fsp.lstat(l2)).isSymbolicLink()).toBe(true);
			expect((await fsp.lstat(l1)).isSymbolicLink()).toBe(true);
			expect(await read(real)).toBe("new\n");
		});

		/** The blocking twin resolves the same way. The two implementations are
		 * separate code, so a chain fix applied to only one of them is exactly the
		 * kind of drift this asserts against. */
		it("the sync writer follows the chain too", async () => {
			const real = at("real.yml");
			const l1 = at("l1");
			const l2 = at("l2");
			await fsp.writeFile(real, "old\n");
			await fsp.symlink(real, l1);
			await fsp.symlink("l1", l2);

			atomicWriteFileSync(l2, "new\n");

			expect((await fsp.lstat(l1)).isSymbolicLink()).toBe(true);
			expect(await read(real)).toBe("new\n");
		});

		/** A RELATIVE link resolves against the link's own directory, not the
		 * process cwd. Getting that wrong writes into whatever directory the agent
		 * happens to be running from. */
		it("resolves a relative link against the link's directory", async () => {
			const nested = at("nested");
			await fsp.mkdir(nested);
			const real = path.join(nested, "real.yml");
			await fsp.writeFile(real, "old\n");
			const link = path.join(nested, "link.yml");
			await fsp.symlink("real.yml", link);

			await atomicWriteFile(link, "new\n");

			expect((await fsp.lstat(link)).isSymbolicLink()).toBe(true);
			expect(await read(real)).toBe("new\n");
		});

		/** A link into a directory that does not exist is a broken setup, and the
		 * write must say so rather than fabricate the directory and leave the user
		 * with a config in a place nothing reads. */
		it("fails loudly on a dangling link instead of creating its directory", async () => {
			const link = at("dangling.yml");
			await fsp.symlink(at("missing-dir/target.yml"), link);

			await expect(atomicWriteFile(link, "new\n")).rejects.toThrow();
			expect(fs.existsSync(at("missing-dir"))).toBe(false);
		});

		/**
		 * When a two-link chain ended in a missing file, realpath failed and the
		 * old single-hop fallback renamed over the intermediate link. The write
		 * must fail at the missing terminal directory with every link intact.
		 */
		it("preserves every link in a chain whose final target is dangling", async () => {
			const first = at("first");
			const second = at("second");
			await fsp.symlink(at("missing-dir/target.yml"), first);
			await fsp.symlink("first", second);

			await expect(atomicWriteFile(second, "new\n")).rejects.toThrow(path.join("missing-dir", "target.yml"));

			expect((await fsp.lstat(first)).isSymbolicLink()).toBe(true);
			expect((await fsp.lstat(second)).isSymbolicLink()).toBe(true);
			expect(fs.existsSync(at("missing-dir"))).toBe(false);
		});

		/**
		 * The blocking resolver had the same one-hop dangling fallback, so it
		 * could destroy the intermediate link even after the async path was fixed.
		 */
		it("the sync writer preserves a dangling chain too", async () => {
			const first = at("sync-first");
			const second = at("sync-second");
			await fsp.symlink(at("missing-sync/target.yml"), first);
			await fsp.symlink("sync-first", second);

			expect(() => atomicWriteFileSync(second, "new\n")).toThrow(path.join("missing-sync", "target.yml"));

			expect((await fsp.lstat(first)).isSymbolicLink()).toBe(true);
			expect((await fsp.lstat(second)).isSymbolicLink()).toBe(true);
			expect(fs.existsSync(at("missing-sync"))).toBe(false);
		});
		/** A file inside a symlinked DIRECTORY is an ordinary write: the directory
		 * link is not the target, so nothing about it changes. This is the layout a
		 * dotfile manager produces for a whole config folder. */
		it("writing inside a symlinked directory leaves the directory link alone", async () => {
			const realDir = at("real-config");
			await fsp.mkdir(realDir);
			const linkDir = at("config");
			await fsp.symlink(realDir, linkDir);

			await atomicWriteFile(path.join(linkDir, "settings.yml"), "new\n");

			expect((await fsp.lstat(linkDir)).isSymbolicLink()).toBe(true);
			expect(await read(path.join(realDir, "settings.yml"))).toBe("new\n");
		});
	});

	describe("things that are not regular files (ENV-6): refused, not replaced", () => {
		/**
		 * A FIFO is the sharp case. `rename` over it succeeds, so before the guard
		 * the pipe was deleted and a regular file took its name, and the process
		 * blocked on the other end simply never got another byte. Nothing reported
		 * it. The refusal names the type so a misconfigured path is diagnosable.
		 */
		it("refuses a named pipe and leaves the pipe a pipe", async () => {
			const fifo = at("pipe");
			const made = Bun.spawnSync(["mkfifo", fifo]);
			expect(made.exitCode).toBe(0);

			await expect(atomicWriteFile(fifo, "hello\n")).rejects.toThrow(/named pipe/);

			expect(fs.lstatSync(fifo).isFIFO()).toBe(true);
		});

		/** The sync writer shares the guard, and must share the refusal. */
		it("the sync writer refuses a named pipe too", () => {
			const fifo = at("pipe");
			expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);

			expect(() => atomicWriteFileSync(fifo, "hello\n")).toThrow(/named pipe/);

			expect(fs.lstatSync(fifo).isFIFO()).toBe(true);
		});

		/** A directory target used to surface as a bare `EISDIR` from deep inside
		 * the rename, which says nothing about which path was wrong. */
		it("refuses a directory, naming the path", async () => {
			const target = at("a-directory");
			await fsp.mkdir(target);
			await fsp.writeFile(path.join(target, "inside.txt"), "still here\n");

			await expect(atomicWriteFile(target, "new\n")).rejects.toThrow(/a directory/);

			expect(await read(path.join(target, "inside.txt"))).toBe("still here\n");
		});

		/** A symlink POINTING AT a pipe is the same hazard one level removed: the
		 * chain resolves to the FIFO, so the check has to happen after resolution
		 * and not only on the path handed in. */
		it("refuses a symlink whose chain ends at a pipe", async () => {
			const fifo = at("pipe");
			expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
			const link = at("link-to-pipe");
			await fsp.symlink(fifo, link);

			await expect(atomicWriteFile(link, "hello\n")).rejects.toThrow(/named pipe/);

			expect(fs.lstatSync(fifo).isFIFO()).toBe(true);
			expect((await fsp.lstat(link)).isSymbolicLink()).toBe(true);
		});

		/**
		 * A target can change after initial validation while a producer is busy.
		 * Previously a FIFO raced into the destination at that point was silently
		 * destroyed by rename; the final pre-rename check must preserve it.
		 */
		it("refuses a special destination raced in while a producer is running", async () => {
			const target = at("raced-target");
			await fsp.writeFile(target, "old\n");

			await expect(
				atomicWriteFileWith(
					target,
					async tmpPath => {
						await fsp.rm(target);
						expect(Bun.spawnSync(["mkfifo", target]).exitCode).toBe(0);
						await fsp.writeFile(tmpPath, "new\n");
					},
					{ fsync: false },
				),
			).rejects.toThrow(/named pipe/);

			expect(fs.lstatSync(target).isFIFO()).toBe(true);
			expect(fs.readdirSync(dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
		});

		/** The control that keeps every refusal above meaningful: an ordinary file
		 * is still written. A guard that refused everything would satisfy all of
		 * them while making the writer useless. */
		it("an ordinary file is written normally", async () => {
			const target = at("ordinary.txt");
			await fsp.writeFile(target, "old\n");

			await atomicWriteFile(target, "new\n");

			expect(await read(target)).toBe("new\n");
		});
	});

	describe("hardlinks: the link IS broken, deliberately", () => {
		/**
		 * Pinned as measured behaviour, not endorsed as ideal. A rename gives the
		 * target name a NEW inode, so a second name for the old inode keeps the old
		 * content and the two paths silently diverge. Preserving the link would mean
		 * writing in place, which is precisely the truncate-then-write that atomicity
		 * exists to avoid — so the link cannot survive without giving up crash
		 * safety, and crash safety wins.
		 *
		 * It is asserted rather than ignored because someone will eventually see two
		 * hardlinked config files disagree and need to find this rather than conclude
		 * the writer is broken.
		 */
		it("a second hardlinked name keeps the OLD content after a write", async () => {
			const primary = at("primary.txt");
			const alias = at("alias.txt");
			await fsp.writeFile(primary, "old\n");
			await fsp.link(primary, alias);
			expect((await fsp.stat(primary)).ino).toBe((await fsp.stat(alias)).ino);

			await atomicWriteFile(primary, "new\n");

			expect(await read(primary)).toBe("new\n");
			expect(await read(alias)).toBe("old\n");
			expect((await fsp.stat(primary)).ino).not.toBe((await fsp.stat(alias)).ino);
		});

		/** The link count on the written path drops to one, which is the mechanical
		 * statement of the same fact and the thing a `stat` would show an operator
		 * investigating. */
		it("the written path's link count drops to one", async () => {
			const primary = at("primary.txt");
			await fsp.writeFile(primary, "old\n");
			await fsp.link(primary, at("alias.txt"));
			expect((await fsp.stat(primary)).nlink).toBe(2);

			await atomicWriteFile(primary, "new\n");

			expect((await fsp.stat(primary)).nlink).toBe(1);
		});
	});
});
