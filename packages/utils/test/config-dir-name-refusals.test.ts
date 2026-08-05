/**
 * `VEYYON_CONFIG_DIR` is a PATH to the config root, and a value that cannot mean one, or
 * that lands back inside the operator's home, is refused rather than reinterpreted.
 *
 * ## The inversion this file records
 *
 * It used to be a NAME joined onto `os.homedir()`, and that had the rule exactly backwards:
 *
 *  - A BARE NAME was accepted and created a real directory in the real home. Assigning
 *    `process.env.HOME` does not move `os.homedir()` under Bun, so every suite that
 *    "isolated" itself with `VEYYON_CONFIG_DIR=".veyyon-mysuite"` was writing to
 *    `~/.veyyon-mysuite`. 136 of those accumulated in one operator's home. The mechanism
 *    read as isolation and was its opposite.
 *  - An ABSOLUTE PATH was REFUSED. `VEYYON_CONFIG_DIR=/srv/veyyon` threw, so the one
 *    spelling that could not possibly land in the home was the one spelling forbidden, and
 *    the sanctioned escape was `path.relative(os.homedir(), tempRoot)`.
 *
 * So the refusals moved. An absolute path outside the home is now the CORRECT value and is
 * taken as written; what is refused is a destination inside the home. That refusal is
 * lifted inside the test sandbox, where the home is a disposable tmpfs and the operator's
 * real home is not in the filesystem view at all -- which is why this suite, which runs in
 * the sandbox, can still use in-home values freely. The refusal itself is exercised where
 * it has to be, in a child process with the marker cleared:
 * `packages/utils/test/sandbox-gate-contracts.test.ts`.
 *
 * The messages are pinned by content as well as by throwing. An error that does not name
 * the variable, the value, and where the data would have gone leaves the user with the same
 * mystery they started with.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigDirName, getConfigRootOverride, refreshDirsFromEnv } from "@veyyon/utils/dirs";

const KEY = "VEYYON_CONFIG_DIR";

/** Read the home-relative name back with the variable set to `value`. */
function nameWith(value: string | undefined): string {
	if (value === undefined) delete process.env[KEY];
	else process.env[KEY] = value;
	return getConfigDirName();
}

/** Read the resolved absolute root back with the variable set to `value`. */
function rootWith(value: string): string | undefined {
	process.env[KEY] = value;
	return getConfigRootOverride();
}

/** Restore the variable this file scribbles on, whatever the test did to it. */
function restoring(): () => void {
	const saved = process.env[KEY];
	return () => {
		if (saved === undefined) delete process.env[KEY];
		else process.env[KEY] = saved;
		refreshDirsFromEnv();
	};
}

describe("an absolute VEYYON_CONFIG_DIR outside the home", () => {
	afterEach(restoring());

	/**
	 * THE regression, inverted. This used to throw; before that it was joined under the
	 * home and produced `~/srv/veyyon`, so the user got a brand new tree inside their home,
	 * the old one stayed where it was, and nothing said so. The value must now come back
	 * exactly as written.
	 */
	it("is taken as written, not joined under the home directory", () => {
		expect(rootWith("/srv/veyyon")).toBe("/srv/veyyon");
	});

	/** The observed form of the original defect: `/tmp/...` landing at `~/tmp/...`. */
	it("does not reappear inside the home for a /tmp value", () => {
		const probe = path.join(os.tmpdir(), "veyyon-abs-probe");
		expect(rootWith(probe)).toBe(probe);
		expect(rootWith(probe)).not.toContain(path.join(os.homedir(), "tmp"));
	});

	/**
	 * The home-relative NAME has to reconstruct the root when a caller joins it onto the
	 * home, which is what `USER_CONFIG_BASES` in `packages/coding-agent/src/config.ts` does.
	 * A basename would answer `veyyon` here and rebuild `~/veyyon`, which is the doubled
	 * path all over again one layer up.
	 */
	it("yields a name that rebuilds the same root when joined onto the home", () => {
		const name = nameWith("/srv/veyyon");
		expect(path.join(os.homedir(), name)).toBe("/srv/veyyon");
	});

	/**
	 * A Windows-style value on a POSIX host is the one absolute-looking form still refused.
	 * `path` does not read it as absolute, so it would be resolved as a RELATIVE name and
	 * create a directory whose name contains a backslash: invisible in a listing, and
	 * nothing the author could have meant.
	 */
	it("is refused when written for the other platform", () => {
		expect(() => nameWith("C:\\veyyon")).toThrow(/absolute path for another platform/);
		expect(() => nameWith("D:/veyyon")).toThrow(/absolute path for another platform/);
		expect(() => nameWith("\\\\server\\share\\veyyon")).toThrow(/absolute path for another platform/);
	});

	/** And the message has to name a form that works, or the user's goal is still unmet. */
	it("names a usable spelling in the refusal", () => {
		expect(() => nameWith("C:\\veyyon")).toThrow(/"\/srv\/veyyon"/);
	});
});

describe("a VEYYON_CONFIG_DIR that walks out of the home directory", () => {
	afterEach(restoring());

	/**
	 * Still accepted, and still the shape the whole suite isolates through:
	 * `path.relative(os.homedir(), tempRoot)`. Refusing it once broke 83 tests. It is not
	 * the mistake the in-home case is -- it leaves the home, which is the whole point --
	 * and an absolute path is now simply the clearer way to write the same thing.
	 */
	it("is accepted and resolves out of the home", () => {
		const root = rootWith("../shared");
		expect(root).toBe(path.resolve(os.homedir(), "../shared"));
		expect(nameWith("../shared")).toBe("../shared");
	});

	it("is accepted with the .. buried in the middle", () => {
		expect(rootWith("state/../../shared")).toBe(path.resolve(os.homedir(), "../shared"));
	});

	/** A name that merely CONTAINS dots is an ordinary directory name, not a traversal. */
	it("treats a name with dots that is not a .. segment as an ordinary name", () => {
		expect(nameWith("..veyyon")).toBe("..veyyon");
		expect(nameWith(".veyyon.test")).toBe(".veyyon.test");
	});
});

describe("a blank VEYYON_CONFIG_DIR", () => {
	afterEach(restoring());

	/** Unset and empty both mean "I did not choose", and the default answers both. Empty is
	 * how a shell passes an unset-but-exported variable. */
	it("falls back to the default when unset or empty", () => {
		// Literal ".veyyon", not CONFIG_DIR_NAME: this is where every user's config,
		// credentials and sessions live. Against the constant, a rename would move the whole
		// config root and this test would call it correct.
		expect(nameWith(undefined)).toBe(".veyyon");
		expect(nameWith("")).toBe(".veyyon");
		process.env[KEY] = "";
		expect(getConfigRootOverride()).toBeUndefined();
	});

	/** Whitespace is different: it is a value, and it would create a directory whose name is
	 * invisible in every listing. */
	it("refuses whitespace rather than creating an unnameable directory", () => {
		expect(() => nameWith(" ")).toThrow(/whitespace \(" "\)/);
		expect(() => nameWith("\t")).toThrow(/whitespace/);
	});
});

describe("the values that must keep working", () => {
	afterEach(restoring());

	/**
	 * In-home values are the sandbox's own case, and this suite runs in the sandbox, so they
	 * resolve rather than throw. Outside the sandbox they are refused, which is the contract
	 * `sandbox-gate-contracts.test.ts` owns: it is the only place that can clear the marker,
	 * because the marker is what let this process start.
	 */
	it("accepts a plain directory name under the sandbox home", () => {
		expect(rootWith(".veyyon")).toBe(path.join(os.homedir(), ".veyyon"));
		expect(nameWith(".veyyon-work")).toBe(".veyyon-work");
	});

	it("accepts a nested relative name", () => {
		expect(nameWith(".veyyon-test-1234/inner")).toBe(path.join(".veyyon-test-1234", "inner"));
	});
});

describe("the refusal on the module-load path", () => {
	const repoRoot = path.resolve(import.meta.dir, "../../..");

	/**
	 * `getBaseConfigRoot` runs while `dirs.ts` is being imported, so a bad value must fail at
	 * STARTUP with the explanation rather than reaching the first write. That ordering cannot
	 * be observed from a process that has already imported the module successfully, so this
	 * spawns a real one.
	 *
	 * The bad value here is the foreign-platform form rather than an in-home path, because
	 * the child inherits this process's sandbox marker and an in-home path is legitimate
	 * under it. The in-home refusal is spawned with the marker cleared in
	 * `sandbox-gate-contracts.test.ts`.
	 */
	it("fails the import and prints the explanation", () => {
		const result = spawnSync(process.execPath, ["-e", 'await import("@veyyon/utils/dirs")'], {
			cwd: repoRoot,
			env: { ...process.env, [KEY]: "C:\\veyyon" },
			encoding: "utf8",
		});

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(KEY);
		expect(result.stderr).toContain("C:\\veyyon");
	});

	/** The control: the same import with a usable value must succeed, so the test above is
	 * proving the refusal and not a broken spawn. */
	it("imports cleanly with a usable value", () => {
		const result = spawnSync(process.execPath, ["-e", 'await import("@veyyon/utils/dirs")'], {
			cwd: repoRoot,
			env: { ...process.env, [KEY]: path.join(os.tmpdir(), "veyyon-load-control") },
			encoding: "utf8",
		});

		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
	});
});
