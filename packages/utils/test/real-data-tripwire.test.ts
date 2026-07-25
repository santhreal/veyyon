import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
			// A sibling whose name merely starts with the root's name must NOT be caught.
			expect(__tripwire.isInside(`${root}-other`, root)).toBe(false);
		});
	});
});
