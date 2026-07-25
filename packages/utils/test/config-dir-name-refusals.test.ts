/**
 * `VEYYON_CONFIG_DIR` names a directory under your home, and a value that cannot
 * mean that is refused rather than reinterpreted.
 *
 * Every caller of `getConfigDirName()` joins the result onto the home directory,
 * which made two mistakes silent and expensive:
 *
 *  - `VEYYON_CONFIG_DIR=/srv/veyyon` became `~/srv/veyyon`. Somebody moving their
 *    config to another volume got a NEW tree inside their home, the old one stayed
 *    where it was, and nothing said so. The observed form of this was
 *    `VEYYON_CONFIG_DIR=/tmp/veyyon-abs-probe` resolving to
 *    `/home/you/tmp/veyyon-abs-probe/profiles/default/agent`.
 *  - Whitespace only, which created a directory whose name is invisible in a listing.
 *
 * A `..` value is ALLOWED, deliberately, and that boundary is pinned here too: it is
 * the only way a test can move the config root into a temp directory, because
 * `os.homedir()` cannot be changed mid-process under Bun.
 *
 * The refusals are the contract, so they are pinned here by message content as well
 * as by throwing: an error that does not name the variable, the value, and where the
 * data would have gone leaves the user with the same mystery they started with.
 *
 * The accepted values are pinned just as carefully. A refusal that also rejects a
 * plain name would break every relocated install and every test that isolates
 * through this variable, so the boundary is asserted from both sides.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getConfigDirName, refreshDirsFromEnv } from "@veyyon/utils/dirs";

const KEY = "VEYYON_CONFIG_DIR";

/** Read the name back with the variable set to `value`, restoring it afterwards. */
function nameWith(value: string | undefined): string {
	if (value === undefined) delete process.env[KEY];
	else process.env[KEY] = value;
	return getConfigDirName();
}

describe("an absolute VEYYON_CONFIG_DIR", () => {
	const saved = process.env[KEY];

	afterEach(() => {
		if (saved === undefined) delete process.env[KEY];
		else process.env[KEY] = saved;
		refreshDirsFromEnv();
	});

	/** THE regression: this used to return the path unchanged, and the caller then
	 * joined it under the home directory. */
	it("is refused instead of being joined under the home directory", () => {
		expect(() => nameWith("/srv/veyyon")).toThrow(/absolute path "\/srv\/veyyon"/);
	});

	/** The message has to show the path that WOULD have been used, because that is
	 * the surprising part and the only way the user recognizes the mistake. */
	it("names the directory it would have created", () => {
		expect(() => nameWith("/srv/veyyon")).toThrow(path.join(os.homedir(), "srv", "veyyon"));
	});

	/** And it has to point at the mechanism that does accept an absolute path,
	 * otherwise the user's actual goal is still unmet after the error. */
	it("points at the XDG variables, which do take absolute paths", () => {
		expect(() => nameWith("/srv/veyyon")).toThrow(/XDG_CONFIG_HOME/);
		expect(() => nameWith("/srv/veyyon")).toThrow(/XDG_STATE_HOME/);
	});

	/** A Windows-style value on a POSIX host is not absolute to `path`, so it would
	 * have created a directory whose NAME contains a backslash. Same mistake, and it
	 * gets the same message wherever the value was authored. */
	it("is refused when written for the other platform", () => {
		expect(() => nameWith("C:\\veyyon")).toThrow(/absolute path "C:\\veyyon"/);
		expect(() => nameWith("D:/veyyon")).toThrow(/absolute path/);
		expect(() => nameWith("\\\\server\\share\\veyyon")).toThrow(/absolute path/);
	});
});

describe("a VEYYON_CONFIG_DIR that walks out of the home directory", () => {
	const saved = process.env[KEY];

	afterEach(() => {
		if (saved === undefined) delete process.env[KEY];
		else process.env[KEY] = saved;
		refreshDirsFromEnv();
	});

	/**
	 * This one is ALLOWED, and that is a decision rather than an oversight, so it is
	 * pinned: `os.homedir()` is fixed for the life of a process under Bun, so a suite
	 * that needs the config root inside a temp directory cannot move the home and has
	 * to reach out of it. `path.relative(os.homedir(), tempRoot)` is the documented
	 * lever (`docs/internal/testing.md`), it produces exactly this shape, and the
	 * whole utils suite isolates through it. Refusing it once broke 83 tests.
	 *
	 * It is also not the mistake the absolute case is: `path.join` does precisely what
	 * the value says, so the user gets the directory they wrote.
	 */
	it("is accepted, because it is how a test moves the config root into a temp dir", () => {
		expect(nameWith("../shared")).toBe("../shared");
		expect(nameWith(path.relative(os.homedir(), path.join(os.tmpdir(), "veyyon-root")))).toContain("..");
	});

	it("is accepted with the .. buried in the middle", () => {
		expect(nameWith("state/../../shared")).toBe("state/../../shared");
	});

	/** A name that merely CONTAINS dots is an ordinary directory name and must not be
	 * confused with a traversal. */
	it("accepts a name with dots that is not a .. segment", () => {
		expect(nameWith("..veyyon")).toBe("..veyyon");
		expect(nameWith(".veyyon.test")).toBe(".veyyon.test");
	});
});

describe("a blank VEYYON_CONFIG_DIR", () => {
	const saved = process.env[KEY];

	afterEach(() => {
		if (saved === undefined) delete process.env[KEY];
		else process.env[KEY] = saved;
		refreshDirsFromEnv();
	});

	/** Unset and empty both mean "I did not choose", and the default is the right
	 * answer for both. Empty is how a shell passes an unset-but-exported variable. */
	it("falls back to the default when unset or empty", () => {
		expect(nameWith(undefined)).toBe(CONFIG_DIR_NAME);
		expect(nameWith("")).toBe(CONFIG_DIR_NAME);
	});

	/** Whitespace is different: it is a value, and it would create a directory whose
	 * name is invisible in every listing. */
	it("refuses whitespace rather than creating an unnameable directory", () => {
		expect(() => nameWith(" ")).toThrow(/whitespace \(" "\)/);
		expect(() => nameWith("\t")).toThrow(/whitespace/);
	});
});

describe("the values that must keep working", () => {
	const saved = process.env[KEY];

	afterEach(() => {
		if (saved === undefined) delete process.env[KEY];
		else process.env[KEY] = saved;
		refreshDirsFromEnv();
	});

	it("accepts a plain directory name", () => {
		expect(nameWith(".veyyon")).toBe(".veyyon");
		expect(nameWith(".veyyon-work")).toBe(".veyyon-work");
	});

	/** Tests isolate through this variable with a generated name, and a nested
	 * relative name stays inside the home directory, so both are allowed. */
	it("accepts a nested relative name", () => {
		expect(nameWith(".veyyon-test-1234/inner")).toBe(".veyyon-test-1234/inner");
	});
});

describe("the refusal on the module-load path", () => {
	/** `getConfigDirName` runs while `dirs.ts` is being imported, so a bad value must
	 * fail at startup with the explanation rather than reaching the first write. This
	 * spawns a real process because that ordering cannot be observed in one that has
	 * already imported the module successfully. */
	it("fails the import and prints the explanation", () => {
		const result = spawnSync(process.execPath, ["-e", 'await import("@veyyon/utils/dirs")'], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			env: { ...process.env, [KEY]: "/srv/veyyon" },
			encoding: "utf8",
		});

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(KEY);
		expect(result.stderr).toContain("/srv/veyyon");
	});

	/** The control: the same import with a usable value must succeed, so the test
	 * above is proving the refusal and not a broken spawn. */
	it("imports cleanly with a usable value", () => {
		const result = spawnSync(process.execPath, ["-e", 'await import("@veyyon/utils/dirs")'], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			env: { ...process.env, [KEY]: ".veyyon-load-control" },
			encoding: "utf8",
		});

		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
	});
});
