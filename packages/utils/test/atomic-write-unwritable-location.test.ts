import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile, atomicWriteFileSync, isEnoent, removeWithRetries } from "@veyyon/utils";

/**
 * What a write reports when the location will not accept it (ENV-3).
 *
 * WHY THIS SUITE EXISTS. A read-only config directory is ordinary: a
 * root-installed config, a mounted secret, a directory the user chmod'd while
 * debugging, a container image with a read-only layer. Two things have to hold
 * when a write lands there, and neither is automatic.
 *
 * READS MUST KEEP WORKING. The write is what fails, not the whole config
 * subsystem, so the prior file has to be readable and byte-identical afterwards.
 * A failed write that also truncated or removed the file would turn a
 * permissions problem into data loss.
 *
 * THE REPORT HAS TO NAME THE FILE THE CALLER ASKED FOR. This is the part that
 * was wrong. An atomic write stages its bytes in a temp sibling, so the raw OS
 * error names THAT: `EACCES: permission denied, open
 * '/etc/veyyon/.config.yml.4711.1.tmp'`. The name is different on every attempt,
 * it never existed as far as the operator is concerned, and it sends people
 * hunting for a stray temp file instead of at the directory that stopped them.
 * The writer now restates the failure in terms of the real target while keeping
 * the OS reason, the syscall, the `code`, and the original error as `cause`.
 *
 * The setup is a `chmod 0o500` directory, which is the one permission failure
 * that is reproducible in a test on any POSIX box. Two related conditions are
 * deliberately NOT faked: a disk-full `ENOSPC` needs a loop mount and root, and
 * a read-only MOUNT needs a mount namespace. Both are recorded in the backlog
 * rather than simulated, because a mocked `fs` would only prove that the mock
 * was called.
 */
describe("an atomic write into a location that will not accept it", () => {
	let dir = "";
	let target = "";

	const ORIGINAL = "keep: this\n";

	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), "atomic-unwritable-"));
		target = path.join(dir, "config.yml");
		await fsp.writeFile(target, ORIGINAL);
	});

	afterEach(async () => {
		if (dir) {
			// Restore the mode first: a 0o500 directory cannot have its entries removed.
			try {
				await fsp.chmod(dir, 0o700);
			} catch {}
			await removeWithRetries(dir);
			dir = "";
		}
	});

	/** Make the containing directory read-and-execute only, so a new temp file
	 * cannot be created in it while the existing file stays readable. */
	async function sealDirectory(): Promise<void> {
		await fsp.chmod(dir, 0o500);
	}

	/** Run the write and return the rejection, failing loudly if it succeeded. */
	async function expectRefusal(): Promise<NodeJS.ErrnoException> {
		try {
			await atomicWriteFile(target, "new: value\n");
		} catch (error) {
			return error as NodeJS.ErrnoException;
		}
		throw new Error("expected the write into a read-only directory to fail, but it succeeded");
	}

	describe("the failure is reported in terms of the caller's file", () => {
		it("names the target file", async () => {
			await sealDirectory();

			const error = await expectRefusal();

			expect(error.message).toContain(target);
		});

		it("does NOT name the internal temp file", async () => {
			// The defect this suite was written for. The temp name is an
			// implementation detail with a different value on every attempt, and it is
			// what the operator used to be handed.
			await sealDirectory();

			const error = await expectRefusal();

			expect(error.message).not.toMatch(/\.tmp\b/);
		});

		it("keeps the operating system's reason and syscall", async () => {
			// The rewrite must not swallow what actually went wrong. "Cannot write
			// config.yml" with no reason is barely better than the temp path.
			await sealDirectory();

			const error = await expectRefusal();

			expect(error.message).toContain("EACCES");
			expect(error.message).toContain("permission denied");
		});

		it("explains why a temporary file was involved at all", async () => {
			// Without this the message reads as though the write was attempted
			// directly, and a reader who then finds a `.tmp` in a directory listing
			// has no way to connect the two.
			await sealDirectory();

			const error = await expectRefusal();

			expect(error.message).toMatch(/temporary file/i);
		});

		it("preserves the error code, so callers matching on it still work", async () => {
			// `isEnoent`, `isFsError` and every `err.code === "EACCES"` check in the
			// tree read this field. A rewrite that dropped it would silently change
			// control flow at call sites that never saw a message.
			await sealDirectory();

			const error = await expectRefusal();

			expect(error.code).toBe("EACCES");
			expect(isEnoent(error)).toBe(false);
		});

		it("carries the original error as `cause`", async () => {
			// The raw error is still the ground truth for anything that wants the
			// untouched OS message, so it travels rather than being discarded.
			await sealDirectory();

			const error = await expectRefusal();

			expect(error.cause).toBeInstanceOf(Error);
			expect((error.cause as Error).message).toMatch(/\.tmp\b/);
		});
	});

	describe("the existing file survives", () => {
		it("is byte-identical after the failed write", async () => {
			await sealDirectory();

			await expectRefusal();
			await fsp.chmod(dir, 0o700);

			expect(await fsp.readFile(target, "utf8")).toBe(ORIGINAL);
		});

		it("is still readable while the directory is sealed", async () => {
			// The point of ENV-3: reads keep working. A read-only config directory
			// must degrade to "you cannot change this", not to "veyyon cannot start".
			await sealDirectory();
			await expectRefusal();

			expect(await fsp.readFile(target, "utf8")).toBe(ORIGINAL);
		});

		it("leaves no temp debris behind", async () => {
			await sealDirectory();

			await expectRefusal();
			await fsp.chmod(dir, 0o700);

			expect(await fsp.readdir(dir)).toEqual(["config.yml"]);
		});
	});

	describe("the blocking twin behaves the same way", () => {
		it("names the target, hides the temp, and keeps the file intact", async () => {
			// Separate code from the async writer, so the same three claims are made
			// against it rather than assumed to carry over.
			await sealDirectory();

			let error: NodeJS.ErrnoException | undefined;
			try {
				atomicWriteFileSync(target, "new: value\n");
			} catch (err) {
				error = err as NodeJS.ErrnoException;
			}

			expect(error?.message).toContain(target);
			expect(error?.message).not.toMatch(/\.tmp\b/);
			expect(error?.code).toBe("EACCES");
			expect(fs.readFileSync(target, "utf8")).toBe(ORIGINAL);
		});
	});

	describe("what must NOT change", () => {
		it("a writable directory still writes normally", async () => {
			// The control. Every assertion above is satisfied by a writer that fails
			// on everything, which would be a considerably worse defect than an
			// unhelpful message.
			await atomicWriteFile(target, "new: value\n");

			expect(await fsp.readFile(target, "utf8")).toBe("new: value\n");
		});

		it("an error that never mentioned the temp file is passed through unchanged", async () => {
			// The rewrite is scoped to messages quoting the temp path. A refusal
			// raised before any temp exists is already phrased for the operator, and
			// appending the temp-file explanation to it would be noise about a file
			// that was never created.
			const fifo = path.join(dir, "pipe");
			expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);

			const error = await atomicWriteFile(fifo, "x\n").then(
				() => undefined,
				(err: unknown) => err as Error,
			);

			expect(error?.message).toContain("named pipe");
			expect(error?.message).not.toMatch(/temporary file/i);
		});

		it("a dangling symlink's missing directory is reported by its real name", async () => {
			// The temp for a symlinked target lives beside the RESOLVED file, so the
			// ENOENT quotes a temp inside the missing directory. The rewrite turns
			// that into the target the link points at, which is the path the operator
			// has to create — and it keeps the missing directory visible in it.
			const link = path.join(dir, "dangling.yml");
			await fsp.symlink(path.join(dir, "missing-dir", "real.yml"), link);

			const error = await atomicWriteFile(link, "x\n").then(
				() => undefined,
				(err: unknown) => err as Error,
			);

			expect(error?.message).toContain(path.join("missing-dir", "real.yml"));
			expect(error?.message).not.toMatch(/\.tmp\b/);
		});
	});
});
