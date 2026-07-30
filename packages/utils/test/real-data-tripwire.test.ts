import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { __tripwire, REAL_CONFIG_ROOT_ENV } from "./helpers/real-data-tripwire";

/**
 * The tripwire is the last line between this test suite and the developer's real
 * credentials, so its own behavior is proven here rather than assumed. A safety
 * mechanism nobody tests is a safety mechanism nobody has.
 *
 * Every probe below aims at a path that is INSIDE the real config root but whose
 * parent directory does not exist. That is deliberate: if the tripwire were
 * missing, the operation fails with ENOENT and still creates nothing, so running
 * these tests can never itself damage real data. The assertions require the
 * tripwire's OWN message, so an ENOENT would fail the test rather than pass it by
 * accident.
 */
describe("the real-data tripwire refuses writes into the real veyyon directory", () => {
	/**
	 * A path inside the forbidden root, two levels below any existing directory.
	 *
	 * Refuses to hand back a path at all unless the tripwire is confirmed active.
	 * That ordering is the whole safety of this suite: these probes are real write
	 * attempts against real paths, so if the tripwire were missing — as happens when
	 * `bun test` runs from a package directory and never loads the root bunfig
	 * preload — the probes would perform exactly the damage the tripwire exists to
	 * prevent. It failed that way once during development and created files under the
	 * real config root. Now an inactive tripwire produces a loud error instead of a
	 * write.
	 */
	function probe(name: string): string {
		// Checked on the ACTUAL function objects this suite calls, not merely on a
		// module-level flag: the patch rewrites the `node:fs` exports, so a suite whose
		// own `import * as fs` was evaluated first keeps the unguarded originals and the
		// probes would really write. Verifying the binding is the only honest check.
		if (!__tripwire.isGuarded(fs.writeFileSync) || !__tripwire.isGuarded(fs.mkdirSync)) {
			throw new Error(
				"real-data tripwire is loaded but NOT bound to this module's fs functions, so this suite refuses " +
					"to probe. It must run with the bunfig preload (repository root, or via scripts/ci-test-ts.ts), " +
					"which loads the tripwire before any test module imports node:fs.",
			);
		}
		if (!__tripwire.ENABLED) {
			throw new Error(
				"real-data tripwire is NOT active in this process, so this suite refuses to probe. " +
					"Run tests through `bun scripts/ci-test-ts.ts` or from the repository root, where the " +
					"bunfig preload is loaded.",
			);
		}
		const root = __tripwire.FORBIDDEN[0];
		if (!root) throw new Error("tripwire reported no forbidden root; the preload did not initialize");
		return path.join(root, "__tripwire_probe__", "nested", name);
	}

	it("is active in this process, so the assertions below mean something", () => {
		// Guards the guard: if the preload silently failed to install, every other
		// test here would pass vacuously.
		expect(__tripwire.ENABLED).toBe(true);
		expect(__tripwire.FORBIDDEN.length).toBeGreaterThan(0);
	});

	it("refuses fs.writeFileSync into the real config root", () => {
		expect(() => fs.writeFileSync(probe("x.txt"), "nope")).toThrow(/REAL-DATA TRIPWIRE/);
	});

	it("refuses fs.mkdirSync into the real config root", () => {
		expect(() => fs.mkdirSync(probe("dir"), { recursive: true })).toThrow(/REAL-DATA TRIPWIRE/);
	});

	it("refuses fs.rmSync of anything in the real config root", () => {
		// Deletion is the most damaging operation and the least recoverable, so it is
		// blocked even though the target does not exist.
		expect(() => fs.rmSync(probe("dir"), { recursive: true, force: true })).toThrow(/REAL-DATA TRIPWIRE/);
	});

	it("refuses a rename whose DESTINATION is in the real config root", () => {
		const source = path.join(os.tmpdir(), "tripwire-source");
		// The destination argument is the dangerous one here; a guard that only checked
		// the first argument would let this through.
		expect(() => fs.renameSync(source, probe("moved"))).toThrow(/REAL-DATA TRIPWIRE/);
	});

	/**
	 * Keeps copy sources readable while still protecting the destination argument.
	 * A missing protected source must reach native ENOENT rather than the tripwire.
	 */
	it("allows a protected copy source but refuses a protected copy destination", () => {
		const destination = path.join(os.tmpdir(), `tripwire-copy-${process.pid}`);
		try {
			fs.copyFileSync(probe("copy-source"), destination);
			throw new Error("copy from nonexistent source unexpectedly succeeded");
		} catch (error) {
			expect(String(error)).not.toContain("REAL-DATA TRIPWIRE");
			expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
		}
		expect(() => fs.copyFileSync(destination, probe("copy-destination"))).toThrow(/REAL-DATA TRIPWIRE/);
	});

	describe("guarded open contracts", () => {
		/**
		 * Proves every open variant carries the same active-binding marker as the
		 * other mutators. A late preload must never look guarded when it is not.
		 */
		it("marks callback, synchronous, and promise open bindings as guarded", () => {
			expect(__tripwire.isGuarded(fs.open)).toBe(true);
			expect(__tripwire.isGuarded(fs.openSync)).toBe(true);
			expect(__tripwire.isGuarded(fs.promises.open)).toBe(true);
		});

		/**
		 * Locks out write, create, and truncate modes across string and numeric
		 * flags, including the O_RDONLY|O_TRUNC edge that can still truncate.
		 */
		it("refuses every mutating open variant before the native syscall", () => {
			expect(() => fs.openSync(probe("open-sync.db"), "w")).toThrow(/REAL-DATA TRIPWIRE/);
			expect(() => fs.open(probe("open-callback.db"), "r+", () => {})).toThrow(/REAL-DATA TRIPWIRE/);
			expect(() => fs.promises.open(probe("open-promise.db"), fs.constants.O_RDONLY | fs.constants.O_TRUNC)).toThrow(
				/REAL-DATA TRIPWIRE/,
			);
		});

		/**
		 * Preserves legitimate read access. The safe nonexistent probe must reach
		 * the operating system and return ENOENT rather than a tripwire refusal.
		 */
		it("delegates read-only open variants to the native filesystem", async () => {
			const syncTarget = probe("read-sync.db");
			try {
				fs.openSync(syncTarget, "r");
				throw new Error("read-only open unexpectedly succeeded");
			} catch (error) {
				expect(String(error)).not.toContain("REAL-DATA TRIPWIRE");
				expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
			}

			const callbackResult = Promise.withResolvers<NodeJS.ErrnoException | null>();
			fs.open(probe("read-callback.db"), "r", error => callbackResult.resolve(error));
			const callbackError = await callbackResult.promise;
			expect(String(callbackError)).not.toContain("REAL-DATA TRIPWIRE");
			expect(callbackError?.code).toBe("ENOENT");

			await expect(fs.promises.open(probe("read-promise.db"), "r")).rejects.toMatchObject({ code: "ENOENT" });
		});

		/**
		 * Prevents the mutator registry from silently turning directory reads into
		 * forbidden writes.
		 */
		it("delegates synchronous and promise opendir reads", async () => {
			expect(__tripwire.isGuarded(fs.opendirSync)).toBe(false);
			expect(__tripwire.isGuarded(fs.promises.opendir)).toBe(false);
			try {
				const directory = fs.opendirSync(probe("read-dir"));
				directory.closeSync();
			} catch (error) {
				expect(String(error)).not.toContain("REAL-DATA TRIPWIRE");
				expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
			}
			try {
				const directory = await fs.promises.opendir(probe("read-dir-promise"));
				await directory.close();
			} catch (error) {
				expect(String(error)).not.toContain("REAL-DATA TRIPWIRE");
				expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
			}
		});
	});

	/**
	 * The case the whole mechanism exists for. The incident's damage was SQLite
	 * `INSERT`s through a native handle: no `node:fs` call was ever made, so an
	 * fs-only tripwire would have sat and watched. Opening the database is the point
	 * of interception because that is when SQLite creates the file and its
	 * `-wal`/`-shm` siblings.
	 */
	it("refuses to open a bun:sqlite database inside the real config root", () => {
		expect(() => new Database(probe("agent.db"))).toThrow(/REAL-DATA TRIPWIRE/);
	});

	it("names the offending path and explains the Bun os.homedir() trap in the failure", () => {
		// The message has to teach, because the person who trips it is by definition
		// someone who believed their test was isolated.
		let message = "";
		try {
			fs.writeFileSync(probe("x.txt"), "nope");
		} catch (error) {
			message = String(error);
		}
		expect(message).toContain("__tripwire_probe__");
		expect(message).toContain("os.homedir()");
	});

	it("leaves the real config root completely untouched after all of the above", () => {
		const root = __tripwire.FORBIDDEN[0];
		if (!root) throw new Error("no forbidden root");
		// The proof that these probes are themselves safe: nothing was created.
		expect(fs.existsSync(path.join(root, "__tripwire_probe__"))).toBe(false);
	});

	describe("canonical path containment", () => {
		/**
		 * Reproduces the bypass: the write is lexically under a temp alias but the
		 * alias resolves into the protected tree. A missing leaf must not hide it.
		 */
		it("detects an outside directory symlink into a protected root", () => {
			const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "tripwire-alias-"));
			const protectedRoot = path.join(fixture, "protected");
			const alias = path.join(fixture, "alias");
			fs.mkdirSync(protectedRoot);
			fs.symlinkSync(protectedRoot, alias, process.platform === "win32" ? "junction" : "dir");
			try {
				expect(__tripwire.isInsideResolved(path.join(alias, "missing", "agent.db"), protectedRoot)).toBe(true);
			} finally {
				fs.rmSync(fixture, { recursive: true, force: true });
			}
		});

		/**
		 * Guards the subtle dangling-alias case. `realpath` fails because the target
		 * leaf is absent, but the symlink still identifies the protected destination.
		 */
		it("detects a dangling symlink aimed at a missing protected descendant", () => {
			const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "tripwire-dangling-"));
			const protectedRoot = path.join(fixture, "protected");
			const future = path.join(protectedRoot, "future");
			const alias = path.join(fixture, "alias");
			fs.mkdirSync(future, { recursive: true });
			fs.symlinkSync(future, alias, process.platform === "win32" ? "junction" : "dir");
			fs.rmdirSync(future);
			try {
				expect(__tripwire.isInsideResolved(path.join(alias, "agent.db"), protectedRoot)).toBe(true);
			} finally {
				fs.rmSync(fixture, { recursive: true, force: true });
			}
		});

		/**
		 * Makes resolution errors fail closed instead of allowing the original
		 * mutation after an ambiguous symlink cycle.
		 */
		it("rejects a symlink cycle instead of returning a safe-looking path", () => {
			if (process.platform === "win32") return;
			const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "tripwire-cycle-"));
			const first = path.join(fixture, "first");
			const second = path.join(fixture, "second");
			fs.symlinkSync(second, first);
			fs.symlinkSync(first, second);
			try {
				expect(() => __tripwire.resolveForContainment(path.join(first, "agent.db"))).toThrow();
			} finally {
				fs.rmSync(fixture, { recursive: true, force: true });
			}
		});

		/**
		 * Preserves lexical protection when neither the root nor its descendant
		 * exists yet, which is the safe shape used by direct real-root probes.
		 */
		it("keeps wholly missing protected descendants inside their root", () => {
			const root = path.join(os.tmpdir(), `tripwire-missing-${process.pid}`, "protected");
			expect(__tripwire.isInsideResolved(path.join(root, "one", "two", "agent.db"), root)).toBe(true);
			expect(__tripwire.isInsideResolved(`${root}-other`, root)).toBe(false);
		});

		/**
		 * Ensures Buffer and encoded file URL PathLike values resolve to the same
		 * decoded path the filesystem will mutate.
		 */
		it("resolves Buffer and encoded file URL targets before containment", () => {
			const target = probe("encoded path #.db");
			const url = pathToFileURL(target);
			expect(url.href).toContain("%20");
			expect(url.href).toContain("%23");
			expect(__tripwire.resolveTarget(Buffer.from(target))).toBe(target);
			expect(__tripwire.resolveTarget(url)).toBe(target);
			expect(() => __tripwire.assertNotRealData("buffer probe", Buffer.from(target))).toThrow(/REAL-DATA TRIPWIRE/);
			expect(() => __tripwire.assertNotRealData("URL probe", url)).toThrow(/REAL-DATA TRIPWIRE/);
		});

		/**
		 * Prevents an invalid encoded path separator from being reinterpreted as
		 * harmless percent text when the native filesystem rejects its meaning.
		 */
		it("fails closed for an encoded file URL separator", () => {
			const invalid = new URL("file:///tmp/tripwire%2Fagent.db");
			expect(() => __tripwire.assertNotRealData("encoded URL probe", invalid)).toThrow(/REAL-DATA TRIPWIRE/);
		});

		/**
		 * Extends canonical containment to protected `.veyyon*` siblings in the
		 * real home, even when a temp-directory alias hides the lexical path.
		 */
		it("blocks an outside symlink into a protected real-home sibling", () => {
			if (process.platform === "win32") return;
			const root = __tripwire.FORBIDDEN[0];
			if (!root) throw new Error("no forbidden root");
			const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "tripwire-sibling-alias-"));
			const alias = path.join(fixture, "alias");
			const protectedSibling = path.join(path.dirname(root), `.veyyon-tripwire-${process.pid}-${Date.now()}`);
			fs.symlinkSync(protectedSibling, alias, "dir");
			try {
				expect(() => fs.writeFileSync(path.join(alias, "agent.db"), "nope")).toThrow(/REAL-DATA TRIPWIRE/);
			} finally {
				fs.rmSync(fixture, { recursive: true, force: true });
			}
		});
	});

	describe("what it deliberately allows", () => {
		it("allows writes to temp paths, so ordinary tests are unaffected", () => {
			const target = path.join(os.tmpdir(), `tripwire-allowed-${process.pid}.txt`);
			expect(() => fs.writeFileSync(target, "fine")).not.toThrow();
			expect(fs.readFileSync(target, "utf8")).toBe("fine");
			fs.rmSync(target, { force: true });
		});

		it("allows READS of the real config root, which are non-hermetic but not damaging", () => {
			const root = __tripwire.FORBIDDEN[0];
			if (!root) throw new Error("no forbidden root");
			// Blocking reads would break suites that legitimately inspect real config;
			// only mutation is forbidden.
			expect(() => fs.existsSync(root)).not.toThrow();
		});
	});

	describe("forbidden-root resolution", () => {
		it("uses the root the runner declares, since a sandboxed process cannot find the real home itself", () => {
			// Both os.homedir() and os.userInfo().homedir follow HOME in Bun, so once the
			// runner redirects HOME there is no in-process way back to the real home. The
			// runner therefore passes it explicitly through this variable.
			expect(REAL_CONFIG_ROOT_ENV).toBe("VEYYON_TEST_REAL_CONFIG_ROOT");
		});

		it("treats a path equal to the root, and any descendant, as forbidden", () => {
			const root = __tripwire.FORBIDDEN[0];
			if (!root) throw new Error("no forbidden root");
			expect(__tripwire.isInside(root, root)).toBe(true);
			expect(__tripwire.isInside(path.join(root, "shared-auth", "agent.db"), root)).toBe(true);
			expect(__tripwire.isInside(path.join(root, "..not-a-parent", "agent.db"), root)).toBe(true);
			// A sibling whose name merely starts with the root's name must NOT be caught.
			expect(__tripwire.isInside(`${root}-other`, root)).toBe(false);
		});
	});
});
