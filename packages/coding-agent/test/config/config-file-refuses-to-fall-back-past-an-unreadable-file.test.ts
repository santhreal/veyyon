/**
 * A config that exists and cannot be read is reported, and is never quietly swapped for another file.
 *
 * `ConfigFile#resolveReadPath` chose between `<name>.yml` and the legacy `<name>.yaml` with
 * `fs.existsSync(basePath)`, which answers `false` for a path that cannot be reached exactly as it does
 * for one that is not there, so "absent, use the fallback" and "there but unreachable" were the same
 * branch. The three-state probe splits them: unreachable resolves to ITSELF, so a later read fails on
 * the file the operator meant, and the fault is reported.
 *
 * HOW BIG THIS IS, stated honestly, because the first version of this suite asserted a wrong-file load
 * and did not get one. The two spellings come from one `configPath` and therefore share a directory, so
 * an unsearchable directory makes the fallback unreachable too, and a `chmod 000` FILE still stats
 * through its parent (`pathStateSync` calls that `present`, deliberately). The resolution that genuinely
 * changed is a SYMLINKED base pointing somewhere unreachable, with a readable fallback beside the link.
 * What changed in EVERY case is that the operator is now told: the `ConfigError` this produced went to a
 * `logger.warn` on a file-only transport, and `getMtimeMs` turns the same failure into a throw a watcher
 * swallows, so nothing reached a person.
 *
 * The suite is written around what actually triggers each branch, rather than around the story: an
 * unsearchable PARENT for the unreachable case, and a `chmod 000` file for the case that must NOT report
 * because the contract says a file's bytes are the opener's problem.
 *
 * `chmod 0o000` DOES NOT DENY ROOT, and CI containers routinely run as root, so every case that needs a
 * denial checks that it got one and skips rather than asserting against a path it can still reach.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigFile } from "@veyyon/coding-agent/config/config-file";
import { attachFaultSink, type DetachFaultSink, type Fault } from "@veyyon/utils";
import { type } from "arktype";

const SCHEMA = type({ "value?": "string" });

/**
 * The shape `SCHEMA` validates, named for the generic.
 *
 * `ConfigFile<T>` cannot infer `T` from an ArkType `Type` argument, so without this every `result.value`
 * below is `{}` and the assertions do not compile. Written as one alias rather than repeated at five call
 * sites.
 */
type Configured = { value?: string };

let root: string;
let faults: Fault[];
let detach: DetachFaultSink;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-config-unreadable-"));
	faults = [];
	detach = attachFaultSink(fault => faults.push(fault));
});

afterEach(async () => {
	detach();
	await fs.chmod(root, 0o700).catch(() => {});
	for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
		if (entry.isDirectory()) await fs.chmod(path.join(root, entry.name), 0o700).catch(() => {});
	}
	await fs.rm(root, { recursive: true, force: true });
});

/** Make one file impossible to OPEN, and say whether that actually denied us. */
async function denyRead(target: string): Promise<boolean> {
	await fs.chmod(target, 0o000);
	try {
		await fs.readFile(target, "utf-8");
		await fs.chmod(target, 0o600);
		return false;
	} catch {
		return true;
	}
}

/**
 * Make a directory impossible to TRAVERSE, and say whether that actually denied us.
 *
 * This is what makes a path unreachable rather than merely unopenable: `stat` resolves through the
 * parent, so a file's own mode cannot stop a stat and only a missing `X` on a directory in the path can.
 */
async function denyTraverse(dir: string): Promise<boolean> {
	await fs.chmod(dir, 0o000);
	try {
		await fs.stat(path.join(dir, "probe"));
		await fs.chmod(dir, 0o700);
		return false;
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") {
			await fs.chmod(dir, 0o700);
			return false;
		}
		return true;
	}
}

describe("ConfigFile with an unreadable base file", () => {
	/**
	 * The fallback is NOT used, and the load reports an error rather than another file's contents.
	 *
	 * The two files carry different values, so a pass cannot mean "read something": the assertion is
	 * that the fallback's value is not what came back. Before the fix this returned `{ value: "legacy" }`
	 * with status `ok`, which is a config load that succeeded against a file the operator did not edit.
	 */
	it("reports the fault when the base cannot be reached, and does not answer not-found", async () => {
		const nested = path.join(root, "nested");
		await fs.mkdir(nested);
		const base = path.join(nested, "settings.yml");
		await fs.writeFile(base, "value: mine\n");
		await fs.writeFile(path.join(nested, "settings.yaml"), "value: legacy\n");
		if (!(await denyTraverse(nested))) return;

		const result = new ConfigFile<Configured>("settings", SCHEMA, base).tryLoad();

		// NOT `not-found`. An unreachable config that reports "no config" is how a session comes up on
		// defaults while the operator believes their file is in force.
		expect(result.status).toBe("error");
		expect(result.value?.value).not.toBe("legacy");

		expect(faults).toHaveLength(1);
		expect(faults[0]?.source).toBe("config");
		expect(faults[0]?.text).toContain(base);
		expect(faults[0]?.text).toContain("could not be read");
		expect(faults[0]?.text).toContain("no fallback");
		expect(faults[0]?.context).toMatchObject({ path: base, config: "settings" });
	});

	/**
	 * Reported ONCE, not once per stat.
	 *
	 * `getMtimeMs` calls the same resolver and is what a config watcher polls, so a per-call report puts
	 * the identical line in the log on a timer until someone fixes the permissions. Three resolutions,
	 * one fault. The operator channel would collapse the duplicates by text; the file log would not, and
	 * the fault is a property of the file rather than of the poll.
	 */
	it("reports once however many times the path is resolved", async () => {
		const nested = path.join(root, "nested");
		await fs.mkdir(nested);
		const base = path.join(nested, "settings.yml");
		await fs.writeFile(base, "value: mine\n");
		if (!(await denyTraverse(nested))) return;

		const config = new ConfigFile<Configured>("settings", SCHEMA, base);
		// Driven through `invalidate` rather than through repeated `tryLoad`, which caches its result and
		// would resolve the path exactly once however many times it is called, and rather than through
		// `getMtimeMs`, which PROPAGATES the EACCES (it swallows only ENOENT) and would end the test on
		// the throw instead of on the assertion. Three real resolutions.
		config.tryLoad();
		config.invalidate();
		config.tryLoad();
		config.invalidate();
		config.tryLoad();

		expect(faults).toHaveLength(1);
	});

	/**
	 * `getMtimeMs` propagates the EACCES, which is documented here because three callers do not catch it.
	 *
	 * Pinned as the CURRENT contract rather than asserted as desirable: `ModelRegistry` calls it from
	 * `#reloadStaticModels`, `#isDiscoveryCacheOlderThanModelsConfig` and the static-load bookkeeping,
	 * none of which guard, so an unreachable `models.yml` throws out of a refresh cycle. Failing loudly
	 * beats answering `null` and silently reloading, which is why it is left alone; the test exists so a
	 * change to either side is a deliberate one rather than a surprise, and so the behaviour is written
	 * down where the next reader of this file will find it.
	 */
	it("propagates a traversal denial out of getMtimeMs", async () => {
		const nested = path.join(root, "nested");
		await fs.mkdir(nested);
		const base = path.join(nested, "settings.yml");
		await fs.writeFile(base, "value: mine\n");
		if (!(await denyTraverse(nested))) return;

		expect(() => new ConfigFile<Configured>("settings", SCHEMA, base).getMtimeMs()).toThrow(/EACCES/);
	});

	/**
	 * A FILE that stats but cannot be opened resolves to itself, and raises NOTHING here.
	 *
	 * The contract boundary, asserted so a later change cannot quietly move it. `pathStateSync` calls a
	 * `chmod 000` file `present` on purpose: whether its bytes can be read is a different question with a
	 * different answer per opener, and the caller is about to open it anyway. So the fallback is not used
	 * (this is the half that must not regress) and the failure arrives as the `ConfigError` from the read
	 * rather than as a fault line, which would otherwise report one problem twice in two voices.
	 */
	it("does not use the fallback for a file it cannot open, and does not report it here", async () => {
		const base = path.join(root, "settings.yml");
		await fs.writeFile(base, "value: mine\n");
		await fs.writeFile(path.join(root, "settings.yaml"), "value: legacy\n");
		if (!(await denyRead(base))) return;

		const result = new ConfigFile<Configured>("settings", SCHEMA, base).tryLoad();

		expect(result.status).toBe("error");
		expect(result.value?.value).not.toBe("legacy");
		expect(faults).toEqual([]);
	});

	/**
	 * A MISSING base still falls back, which is the behaviour the fix had to preserve.
	 *
	 * The legacy `.yaml` spelling is supported precisely so an operator who wrote one keeps working, so a
	 * fix that stopped falling back for everybody would trade a silent wrong-file load for a silent
	 * no-config load. Asserted on the fallback's own value, and on the absence of a fault, since nothing
	 * is wrong in this case and a report here would make the channel noise.
	 */
	it("still falls back when the base is genuinely absent", () => {
		const base = path.join(root, "settings.yml");
		const fallback = path.join(root, "settings.yaml");
		writeFileSync(fallback, "value: legacy\n");

		const result = new ConfigFile<Configured>("settings", SCHEMA, base).tryLoad();

		expect(result.value?.value).toBe("legacy");
		expect(faults).toEqual([]);
	});

	/**
	 * A readable base wins over a present fallback, and raises nothing.
	 *
	 * The ordinary case, asserted so the unreadable branch cannot be satisfied by treating every base as
	 * suspect. This is also the case that would break if the new probe reported `unreadable` for an
	 * ordinary file, which is the mistake the async twin of `pathStateSync` made on its first version by
	 * stat'ing a directory without an access check.
	 */
	it("prefers a readable base over the fallback, silently", () => {
		const base = path.join(root, "settings.yml");
		writeFileSync(base, "value: mine\n");
		writeFileSync(path.join(root, "settings.yaml"), "value: legacy\n");

		const result = new ConfigFile<Configured>("settings", SCHEMA, base).tryLoad();

		expect(result.value?.value).toBe("mine");
		expect(faults).toEqual([]);
	});
});
