/**
 * `XDG_CONFIG_HOME` does not move veyyon's config root, and three sibling XDG variables do move the
 * data, state and cache roots. Both halves are pinned here because the difference between them used to
 * exist only in the author's head: the resolver read three variables, while a user-facing error message
 * and a comment in `dir-env-keys.ts` both told the reader that all four relocated something.
 *
 * WHY THE CONFIG ROOT DELIBERATELY IGNORES IT, so that nobody reads the first suite as a bug and
 * "fixes" it. `XDG_CONFIG_HOME` is set on the large majority of Linux desktops. If the resolver started
 * honouring it as the config root, then on the next launch every one of those users would have their
 * profiles, their credentials, the machine-wide onboarding record and the auth-broker token resolve to a
 * directory that has never existed, and veyyon would present itself as a fresh install with the real
 * tree still sitting untouched in `$HOME`. That is a strictly worse failure than the honesty bug it
 * would be fixing. A conditional relocation ("only when the old root is missing") is not an escape
 * either: it makes the location of a user's credentials depend on the order in which directories happen
 * to appear. The config root is `$HOME/<VEYYON_CONFIG_DIR or .veyyon>`, full stop, and the error message
 * that used to advertise otherwise is pinned in `config-dir-name-refusals.test.ts`.
 *
 * The second suite is the other half of the same contract. Asserting only that `XDG_CONFIG_HOME` does
 * nothing would be satisfied by a resolver that had stopped honouring XDG entirely, so the exact
 * relocated paths for data, state and cache are asserted alongside it, with all four variables set at
 * once the way a real desktop sets them.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetDirsFromEnvForTests,
	APP_NAME,
	CONFIG_DIR_NAME,
	DEFAULT_PROFILE_DIR_NAME,
	getConfigRootDir,
	getGlobalConfigRootDir,
	getLogsDir,
	getPuppeteerDir,
	getSessionsDir,
	PROFILES_DIR_NAME,
} from "@veyyon/utils/dirs";

const KEYS = [
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
	"VEYYON_PROFILE",
	"VEYYON_CONFIG_DIR",
	"VEYYON_CODING_AGENT_DIR",
] as const;

const saved: Record<string, string | undefined> = {};
let tempRoot = "";

/**
 * The resolver only adopts an XDG base once `<base>/veyyon` exists, so a bare assignment proves
 * nothing: the base is ignored and the answer falls back to the config root, which is the result the
 * first suite wants but for the wrong reason. Every base in this file is created before it is set.
 */
function xdgBase(key: string): string {
	const base = path.join(tempRoot, key.toLowerCase());
	fs.mkdirSync(path.join(base, APP_NAME), { recursive: true });
	process.env[key] = base;
	return base;
}

beforeEach(() => {
	for (const key of KEYS) saved[key] = process.env[key];
	for (const key of KEYS) delete process.env[key];
	// Pinned to the default profile through the environment rather than left to
	// `resolveStartupProfileSafe()`, which would otherwise read the developer's own global
	// `config.yml` and resolve `profiles/<their-default>` instead.
	process.env.VEYYON_PROFILE = DEFAULT_PROFILE_DIR_NAME;
	tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-xdg-config-home-"));
});

afterEach(() => {
	for (const key of KEYS) {
		const value = saved[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	__resetDirsFromEnvForTests();
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("XDG_CONFIG_HOME and the config root", () => {
	it("leaves the config root at its exact path under the home directory", () => {
		const configHome = xdgBase("XDG_CONFIG_HOME");
		__resetDirsFromEnvForTests();

		const expected = path.join(os.homedir(), CONFIG_DIR_NAME, PROFILES_DIR_NAME, DEFAULT_PROFILE_DIR_NAME);
		expect(getConfigRootDir()).toBe(expected);
		expect(getGlobalConfigRootDir()).toBe(path.join(os.homedir(), CONFIG_DIR_NAME));
		// Stated the other way round too, because the observed failure was a variable set and
		// ignored, and the failure this test guards against is its mirror image.
		expect(getConfigRootDir().startsWith(configHome)).toBe(false);
	});

	it("moves no category at all, not merely the root", () => {
		xdgBase("XDG_CONFIG_HOME");
		__resetDirsFromEnvForTests();

		const root = path.join(os.homedir(), CONFIG_DIR_NAME, PROFILES_DIR_NAME, DEFAULT_PROFILE_DIR_NAME);
		expect(getSessionsDir()).toBe(path.join(root, "agent", "sessions"));
		expect(getLogsDir()).toBe(path.join(root, "logs"));
		expect(getPuppeteerDir()).toBe(path.join(root, "puppeteer"));
	});

	it("leaves the config directory name to VEYYON_CONFIG_DIR", () => {
		// The route the error message now offers for renaming: a NAME under home. If
		// `XDG_CONFIG_HOME` ever started winning, this is where it would win.
		xdgBase("XDG_CONFIG_HOME");
		process.env.VEYYON_CONFIG_DIR = ".veyyon-renamed";
		__resetDirsFromEnvForTests();

		expect(getGlobalConfigRootDir()).toBe(path.join(os.homedir(), ".veyyon-renamed"));
		expect(getConfigRootDir()).toBe(
			path.join(os.homedir(), ".veyyon-renamed", PROFILES_DIR_NAME, DEFAULT_PROFILE_DIR_NAME),
		);
	});
});

describe("the three XDG bases that do relocate", () => {
	it("puts data, state and cache at their exact XDG paths while the config root stays home", () => {
		// All four set at once, which is what a Linux desktop actually looks like.
		const configHome = xdgBase("XDG_CONFIG_HOME");
		const dataHome = xdgBase("XDG_DATA_HOME");
		const stateHome = xdgBase("XDG_STATE_HOME");
		const cacheHome = xdgBase("XDG_CACHE_HOME");
		__resetDirsFromEnvForTests();

		expect(getSessionsDir()).toBe(path.join(dataHome, APP_NAME, "sessions"));
		expect(getLogsDir()).toBe(path.join(stateHome, APP_NAME, "logs"));
		expect(getPuppeteerDir()).toBe(path.join(cacheHome, APP_NAME, "puppeteer"));
		expect(getConfigRootDir()).toBe(
			path.join(os.homedir(), CONFIG_DIR_NAME, PROFILES_DIR_NAME, DEFAULT_PROFILE_DIR_NAME),
		);
		expect(getConfigRootDir().startsWith(configHome)).toBe(false);
	});

	it("relocates one category without dragging the other two along", () => {
		// Each variable owns exactly one category, so a resolver that collapsed them onto one base
		// would still pass the all-four case above.
		const stateHome = xdgBase("XDG_STATE_HOME");
		__resetDirsFromEnvForTests();

		const root = path.join(os.homedir(), CONFIG_DIR_NAME, PROFILES_DIR_NAME, DEFAULT_PROFILE_DIR_NAME);
		expect(getLogsDir()).toBe(path.join(stateHome, APP_NAME, "logs"));
		expect(getSessionsDir()).toBe(path.join(root, "agent", "sessions"));
		expect(getPuppeteerDir()).toBe(path.join(root, "puppeteer"));
	});
});
