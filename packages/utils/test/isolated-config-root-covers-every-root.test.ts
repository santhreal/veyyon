/**
 * `enterIsolatedConfigRoot` redirects every root the resolver can use, not only the config root.
 *
 * WHY THIS SUITE EXISTS. This helper is the promise the whole test suite rests on: inside it, nothing
 * veyyon writes reaches the developer's real `~/.veyyon`. The REAL-DATA TRIPWIRE enforces that at the
 * filesystem, but a tripwire refusal is a test failure with no explanation attached, so the helper has
 * to be airtight rather than mostly airtight.
 *
 * It was not. `DirResolver` resolves the `data`, `state` and `cache` categories under
 * `XDG_DATA_HOME`, `XDG_STATE_HOME` and `XDG_CACHE_HOME`, falling back to the config root only when
 * the corresponding `$XDG_*_HOME/veyyon` does not exist. The helper knew about `VEYYON_CONFIG_DIR`,
 * `VEYYON_CODING_AGENT_DIR` and `VEYYON_PROFILE` and nothing else, so a developer who has run
 * `veyyon config init-xdg` had every state-category path — `logs/`, `sessions/`, `reports/` — still
 * resolving under their real XDG tree inside a root the helper had just called isolated. It is the
 * same defect the helper already documents for `VEYYON_CODING_AGENT_DIR`, in variables it did not
 * cover.
 *
 * It had already cost a real write. `debug/raw-sse-report-bundle.test.ts` writes a tarball of system
 * info, sanitized environment and resolved settings; it had grown a hand-rolled `XDG_STATE_HOME`
 * redirect that did nothing, because the assignment came after the resolver had been built. That
 * workaround is gone now and this is where the guarantee lives.
 *
 * Each variable is asserted separately, since covering one is not covering the others. Every test
 * CREATES the `$XDG_*_HOME/veyyon` directory before entering, because without it the resolver ignores
 * the base and the assertion would pass on the fallback — a check that cannot fail proves nothing
 * about the helper.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	getConfigRootDir,
	getLogsDir,
	getPuppeteerDir,
	getRemoteDir,
	getSessionsDir,
	refreshDirsFromEnv,
} from "@veyyon/utils/dirs";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "./helpers/isolated-config-root";

const XDG_KEYS = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;

const originals = new Map<string, string | undefined>(XDG_KEYS.map(key => [key, process.env[key]]));

/**
 * A tree standing in for wherever the developer's XDG bases point.
 *
 * A temp directory rather than the real home: the property under test is "outside the isolated
 * root", and a test that made directories in someone's home to prove a point would be a worse
 * citizen than the leak it is checking for.
 */
let outside = "";
let isolated: IsolatedConfigRoot | undefined;

beforeEach(() => {
	outside = mkdtempSync(path.join(os.tmpdir(), "veyyon-xdg-outside-"));
});

afterEach(() => {
	isolated?.restore();
	isolated = undefined;
	for (const [key, value] of originals) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(outside, { recursive: true, force: true });
});

/** True when `child` is inside `parent`, compared on resolved paths rather than on string prefixes. */
function isInside(parent: string, child: string): boolean {
	const relative = path.relative(path.resolve(parent), path.resolve(child));
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Point `key` at a base under `outside` that the resolver will actually accept.
 *
 * The `veyyon` subdirectory is what the resolver probes for, and it is the reason a bare
 * `process.env.XDG_STATE_HOME = "/somewhere"` is not a test: the base is ignored and the resolver
 * quietly uses the config root, which is the answer the test wanted for the wrong reason.
 */
function pointOutside(key: (typeof XDG_KEYS)[number]): string {
	const base = path.join(outside, key.toLowerCase());
	mkdirSync(path.join(base, "veyyon"), { recursive: true });
	process.env[key] = base;
	return base;
}

describe("an isolated config root entered with XDG base directories set", () => {
	/**
	 * THE REGRESSION. `XDG_STATE_HOME` governs the state category, which is where the logs,
	 * sessions and report bundles a test writes actually land.
	 */
	it("keeps the state-category directories inside the root", () => {
		const base = pointOutside("XDG_STATE_HOME");

		isolated = enterIsolatedConfigRoot("xdg-state-leak", { defaultProfile: true });

		expect(isInside(isolated.root, getLogsDir())).toBe(true);
		expect(isInside(isolated.root, getSessionsDir())).toBe(true);
		expect(isInside(base, getLogsDir())).toBe(false);
	});

	it("keeps the cache-category directories inside the root", () => {
		const base = pointOutside("XDG_CACHE_HOME");

		isolated = enterIsolatedConfigRoot("xdg-cache-leak", { defaultProfile: true });

		expect(isInside(isolated.root, getPuppeteerDir())).toBe(true);
		expect(isInside(base, getPuppeteerDir())).toBe(false);
	});

	it("keeps the data-category directories inside the root", () => {
		const base = pointOutside("XDG_DATA_HOME");

		isolated = enterIsolatedConfigRoot("xdg-data-leak", { defaultProfile: true });

		expect(isInside(isolated.root, getRemoteDir())).toBe(true);
		expect(isInside(base, getRemoteDir())).toBe(false);
	});

	it("holds with every XDG base pointed outside at once", () => {
		// The developer's actual situation, rather than one variable at a time.
		const bases = XDG_KEYS.map(pointOutside);

		isolated = enterIsolatedConfigRoot("xdg-all-leak", { defaultProfile: true });

		for (const dir of [getConfigRootDir(), getLogsDir(), getSessionsDir(), getPuppeteerDir(), getRemoteDir()]) {
			expect(isInside(isolated.root, dir), dir).toBe(true);
			for (const base of bases) expect(isInside(base, dir), `${dir} under ${base}`).toBe(false);
		}
	});

	/**
	 * The variables have to come BACK, with their exact values. A helper that clears an XDG base and
	 * forgets to restore it moves where every later suite in the process resolves its paths, which is
	 * the leak class this helper exists to end rather than to join.
	 */
	it("restores each XDG base exactly as it found it", () => {
		const stateBase = pointOutside("XDG_STATE_HOME");
		const cacheBase = pointOutside("XDG_CACHE_HOME");
		delete process.env.XDG_DATA_HOME;

		const entry = enterIsolatedConfigRoot("xdg-restore", { defaultProfile: true });
		// Cleared while inside, which is the whole point.
		expect(process.env.XDG_STATE_HOME).toBeUndefined();
		expect(process.env.XDG_DATA_HOME).toBeUndefined();
		entry.restore();

		expect(process.env.XDG_STATE_HOME).toBe(stateBase);
		expect(process.env.XDG_CACHE_HOME).toBe(cacheBase);
		// Absent must come back absent, not as an empty string: an empty value is still "set", and a
		// reader that treats set as usable would then join onto nothing.
		expect("XDG_DATA_HOME" in process.env).toBe(false);
	});

	/**
	 * A suite that WANTS an XDG base still can, and that is why clearing is safe rather than a
	 * feature removal: the helper clears at entry, so anything set afterwards wins.
	 * `dirs-xdg-categories.test.ts` depends on this, and without it that suite would silently stop
	 * testing XDG at all.
	 */
	it("does not stop a suite from choosing an XDG base after entering", () => {
		isolated = enterIsolatedConfigRoot("xdg-set-after", { defaultProfile: true });
		const chosen = path.join(isolated.root, "chosen-state");
		mkdirSync(path.join(chosen, "veyyon"), { recursive: true });

		process.env.XDG_STATE_HOME = chosen;
		// The resolver caches every path it has answered, so the rebuild is the suite's job. Stated
		// here as the documented sequence rather than left implied.
		refreshDirsFromEnv();

		expect(isInside(chosen, getLogsDir())).toBe(true);
	});
});

describe("an isolated config root entered with no XDG base set", () => {
	it("resolves every category under the root, so the checks above are not about XDG alone", () => {
		// The premise. If the categories did not fall back to the config root, every assertion above
		// would be satisfied by a resolver that ignored XDG entirely, and this suite would prove
		// nothing about the helper.
		for (const key of XDG_KEYS) delete process.env[key];

		isolated = enterIsolatedConfigRoot("xdg-absent", { defaultProfile: true });

		for (const dir of [getConfigRootDir(), getLogsDir(), getSessionsDir(), getPuppeteerDir(), getRemoteDir()]) {
			expect(isInside(isolated.root, dir), dir).toBe(true);
		}
	});
});
