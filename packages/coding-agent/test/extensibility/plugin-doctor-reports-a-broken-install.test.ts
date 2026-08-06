/**
 * `plugin doctor` has to tell "nothing installed yet" apart from "installed and broken".
 *
 * WHY THIS SUITE EXISTS. That distinction IS doctor's output, and for three checks it was not being
 * made. `doctor`'s own doc comment said so in as many words: "a path that exists but cannot be stat'd
 * is exactly the kind of broken install doctor is meant to surface, and `existsSync` reports it as
 * absent", given as the reason it had moved to `pathExists`. The move fixed the event-loop blocking
 * and not the conflation, because `pathExists` returns a BOOLEAN: an unreadable plugins directory
 * still arrived as `false` and was reported as `"Not created yet (no plugins installed)"` with status
 * `ok`. A health check calling a broken install healthy is worse than having no health check, because
 * the operator now has a reason to stop looking.
 *
 * The `package.json` check was the same family one step further on. Everything that was not ENOENT
 * was rethrown, so a plugins manifest with a trailing comma, or one whose permissions had been
 * mangled, made `veyyon plugin doctor` exit non-zero with a raw `SyntaxError` and NO report at all,
 * taking the other checks down with it: the operator learned nothing about their plugins directory,
 * their node_modules, or any installed plugin, because the one file doctor could not read aborted the
 * run before a line was printed. A diagnostic tool must not crash on the ill health it exists to
 * describe.
 *
 * So what these tests pin, one per check and one per state:
 *
 *   1. A fresh install still reads healthy. Absent is `ok`, and that is what keeps the rest honest.
 *   2. Unreadable is an `error` on each of the three checks, with a message naming the path and the
 *      remedy rather than claiming nothing is installed.
 *   3. A corrupt or unreadable manifest is REPORTED, and `doctor` still returns its other checks.
 *   4. The unreadable manifest does not cause a spurious "run npm install": with no readable
 *      dependency list there is nothing to install against, so inventing that advice would send the
 *      operator to fix the wrong thing.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PluginManager } from "@veyyon/coding-agent/extensibility/plugins/manager";
import type { DoctorCheck } from "@veyyon/coding-agent/extensibility/plugins/types";
import * as piUtils from "@veyyon/utils";

let tmpRoot: string;
let pluginsDir: string;
let spies: Array<{ mockRestore: () => void }>;

beforeEach(async () => {
	tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-plugin-doctor-"));
	pluginsDir = path.join(tmpRoot, "plugins");
	await fs.mkdir(pluginsDir, { recursive: true });
	spies = [
		spyOn(piUtils, "getPluginsDir").mockReturnValue(pluginsDir),
		spyOn(piUtils, "getPluginsNodeModules").mockReturnValue(path.join(pluginsDir, "node_modules")),
		spyOn(piUtils, "getPluginsPackageJson").mockReturnValue(path.join(pluginsDir, "package.json")),
		spyOn(piUtils, "getPluginsLockfile").mockReturnValue(path.join(tmpRoot, "veyyon-plugins.lock.json")),
		spyOn(piUtils, "getProjectDir").mockReturnValue(tmpRoot),
		spyOn(piUtils, "getProjectPluginOverridesPath").mockReturnValue(path.join(tmpRoot, "plugin-overrides.json")),
	];
});

afterEach(async () => {
	for (const spy of spies) spy.mockRestore();
	// Restore permissions on every directory before removing, or a 0o000 entry leaves `rm -r` unable
	// to descend and the temp tree leaks.
	await fs.chmod(tmpRoot, 0o700).catch(() => {});
	await fs.chmod(pluginsDir, 0o700).catch(() => {});
	for (const entry of await fs.readdir(pluginsDir, { withFileTypes: true }).catch(() => [])) {
		if (entry.isDirectory()) await fs.chmod(path.join(pluginsDir, entry.name), 0o700).catch(() => {});
	}
	await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** Deny reads on `target`, answering whether the denial took effect. */
async function lock(target: string): Promise<boolean> {
	await fs.chmod(target, 0o000);
	try {
		await fs.readdir(target);
		await fs.chmod(target, 0o700);
		return false;
	} catch {
		return true;
	}
}

/** The named check, so a test asserts on one row rather than on an array index. */
function check(checks: DoctorCheck[], name: string): DoctorCheck | undefined {
	return checks.find(c => c.name === name);
}

describe("a fresh install", () => {
	/**
	 * Reads healthy, with every absent thing reported `ok`.
	 *
	 * The baseline that keeps every assertion below meaningful. A doctor that flagged a fresh install
	 * would be fixed by ignoring it, and the three error states are only useful because this one is
	 * quiet. Asserts the exact messages, because "not created yet" is precisely the string that used
	 * to be shown for the unreadable case too.
	 */
	it("reports absent paths as ok, with no errors", async () => {
		const checks = await new PluginManager(tmpRoot).doctor();

		expect(check(checks, "plugins_directory")).toMatchObject({ status: "ok", message: `Found at ${pluginsDir}` });
		expect(check(checks, "package_manifest")).toMatchObject({
			status: "ok",
			message: "Not created yet (no plugins installed)",
		});
		expect(check(checks, "node_modules")).toMatchObject({
			status: "ok",
			message: "Not needed (no plugins installed)",
		});
		expect(checks.filter(c => c.status === "error")).toEqual([]);
	});
});

describe("an unreadable plugins directory", () => {
	/**
	 * THE ORIGINAL BUG. Reported as an error, not as "not created yet".
	 *
	 * The two states led to the same line because the probe answered a boolean, so an operator whose
	 * plugins tree had lost its permissions was told they had never installed a plugin. The message has
	 * to name the path, say that no plugin can load, and name the two things worth checking, because
	 * "error" alone sends them to reinstall rather than to `chmod`.
	 */
	it("is an error naming the path and the remedy", async () => {
		if (!(await lock(pluginsDir))) return;

		const checks = await new PluginManager(tmpRoot).doctor();
		const dirCheck = check(checks, "plugins_directory");

		expect(dirCheck?.status).toBe("error");
		expect(dirCheck?.message).toContain(pluginsDir);
		expect(dirCheck?.message).toContain("could not be read");
		expect(dirCheck?.message).toContain("no plugin can load");
		expect(dirCheck?.message).toContain("permissions");
		// And emphatically NOT the fresh-install wording, which is the substitution under test.
		expect(dirCheck?.message).not.toContain("Not created yet");
	});
});

describe("an unreadable node_modules", () => {
	/**
	 * An error even with no `package.json`, which is the case that used to read `ok`.
	 *
	 * The old status was `hasNodeModules ? "ok" : hasPkgJson ? "error" : "ok"`, so an unreadable
	 * node_modules with no manifest beside it landed on the final `ok` as "Not needed (no plugins
	 * installed)". A `node_modules` that is THERE is proof that something was installed, so "not
	 * needed" is the one thing it cannot be.
	 */
	it("is an error even when no manifest is present", async () => {
		const nodeModules = path.join(pluginsDir, "node_modules");
		await fs.mkdir(nodeModules);
		if (!(await lock(nodeModules))) return;

		const checks = await new PluginManager(tmpRoot).doctor();
		const nmCheck = check(checks, "node_modules");

		expect(nmCheck?.status).toBe("error");
		expect(nmCheck?.message).toContain(nodeModules);
		expect(nmCheck?.message).toContain("could not be read");
		expect(nmCheck?.message).not.toContain("Not needed");
	});
});

describe("a manifest doctor cannot read", () => {
	/**
	 * Corrupt JSON is REPORTED, and doctor still returns its other checks.
	 *
	 * This used to rethrow, so the command exited on a `SyntaxError` with no report: the operator got
	 * a stack trace instead of the one line telling them their plugins `package.json` is malformed.
	 * The assertion on the other checks is the important half, because reporting this row while losing
	 * the rest would be the same failure in a quieter form.
	 */
	it("reports corrupt JSON as an error and still returns the other checks", async () => {
		await fs.writeFile(path.join(pluginsDir, "package.json"), '{ "dependencies": { "a": "1.0.0", } }');

		const checks = await new PluginManager(tmpRoot).doctor();
		const manifest = check(checks, "package_manifest");

		expect(manifest?.status).toBe("error");
		expect(manifest?.message).toContain(path.join(pluginsDir, "package.json"));
		expect(manifest?.message).toContain("could not be read");
		expect(manifest?.message).toContain("Fix or delete the file");
		// The run survived: the other two checks are present and answered.
		expect(check(checks, "plugins_directory")?.status).toBe("ok");
		expect(check(checks, "node_modules")).toBeDefined();
	});

	/**
	 * And does not turn into a spurious "run npm install".
	 *
	 * The node_modules check escalates to an error when a manifest declares dependencies that are not
	 * installed. With a manifest nobody could parse there is no dependency list to compare against, so
	 * demanding an install would send the operator to fix the wrong file. `hasPkgJson` stays false for
	 * exactly this reason, and the manifest problem is carried by its own row instead.
	 */
	it("does not demand an install it cannot justify", async () => {
		await fs.writeFile(path.join(pluginsDir, "package.json"), "not json at all");

		const checks = await new PluginManager(tmpRoot).doctor();

		expect(check(checks, "package_manifest")?.status).toBe("error");
		expect(check(checks, "node_modules")?.message).not.toContain("npm install");
		expect(check(checks, "node_modules")?.status).toBe("ok");
	});

	/**
	 * AND DOES NOT ANSWER "no plugins installed" ABOUT A MANIFEST IT COULD NOT READ.
	 *
	 * The first fix for the case above reused the no-manifest branch, so the row read "Not needed (no
	 * plugins installed)" whenever the manifest was unreadable. That states as fact the exact thing the
	 * row above it has just said it could not determine, in a report the operator reads as one page: two
	 * lines, one saying the dependency list is unreadable and the next concluding there are no
	 * dependencies. Not needed is a claim ABOUT the list, so it may only be made when the list was read.
	 *
	 * The absent-and-readable case is asserted alongside, because a fix that dropped the phrase for
	 * everybody would satisfy the negative half on its own.
	 */
	it("says the install question is unknown when the manifest is unreadable", async () => {
		await fs.writeFile(path.join(pluginsDir, "package.json"), "not json at all");

		const broken = await new PluginManager(tmpRoot).doctor();

		expect(check(broken, "node_modules")?.message).not.toContain("no plugins installed");
		expect(check(broken, "node_modules")?.message).toContain("unknown");
		expect(check(broken, "node_modules")?.message).toContain(path.join(pluginsDir, "package.json"));

		await fs.rm(path.join(pluginsDir, "package.json"));
		const clean = await new PluginManager(tmpRoot).doctor();

		expect(check(clean, "node_modules")?.message).toBe("Not needed (no plugins installed)");
	});

	/**
	 * A manifest that is present and valid still reports "Found".
	 *
	 * The positive case for the branch above, so the error path cannot be satisfied by reporting every
	 * manifest as broken. A readable manifest whose dependency is not installed is also the one case
	 * where doctor is entitled to demand a reinstall, so both halves are asserted together. The remedy
	 * it names is its own `--fix`, not a bare `npm install`: the manifest it would reinstall from is
	 * the one doctor just read, and an operator running npm by hand in the wrong directory is how the
	 * broken install happened.
	 */
	it("reports a readable manifest as found, and then does demand the missing install", async () => {
		await fs.writeFile(
			path.join(pluginsDir, "package.json"),
			JSON.stringify({ dependencies: { "some-plugin": "1.0.0" } }),
		);

		const checks = await new PluginManager(tmpRoot).doctor();

		expect(check(checks, "package_manifest")).toMatchObject({ status: "ok", message: "Found" });
		expect(check(checks, "node_modules")).toMatchObject({ status: "error" });
		expect(check(checks, "node_modules")?.message).toContain("Missing, so no installed plugin can load");
		expect(check(checks, "node_modules")?.message).toContain("veyyon plugin doctor --fix");
	});
});
