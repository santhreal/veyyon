import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetDirsFromEnvForTests,
	APP_NAME,
	getDocsRsCacheDir,
	getLogsDir,
	getPuppeteerDir,
	getSessionsDir,
	getStatsDbPath,
} from "@veyyon/utils/dirs";
import { Snowflake } from "@veyyon/utils/snowflake";

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

/**
 * Under XDG the three categories are three different roots. `data` holds things
 * the user would miss if they vanished (sessions, databases), `state` holds
 * things that are useful but reproducible (logs, caches of decisions), and
 * `cache` holds things that can be deleted at any time.
 *
 * `DirResolver` memoizes resolved subdirectories, and that cache used to be
 * keyed on the subdirectory name alone. Two categories asking for the same name
 * would then both get whichever root asked first, which is data written under
 * one root and read back from another, on XDG machines only, with nothing
 * logged. These tests pin that the category decides the root and that call
 * order does not.
 */
describe("XDG category roots stay separate", () => {
	let tempRoot = "";
	const saved: Record<string, string | undefined> = {};
	const KEYS = [
		"XDG_DATA_HOME",
		"XDG_STATE_HOME",
		"XDG_CACHE_HOME",
		"VEYYON_PROFILE",
		"VEYYON_CODING_AGENT_DIR",
		"VEYYON_CONFIG_DIR",
	];

	let dataHome = "";
	let stateHome = "";
	let cacheHome = "";

	beforeEach(() => {
		for (const key of KEYS) saved[key] = process.env[key];
		delete process.env.VEYYON_PROFILE;
		delete process.env.VEYYON_CODING_AGENT_DIR;

		tempRoot = path.join(os.tmpdir(), "veyyon-xdg-categories", Snowflake.next());
		// Point the config root at an empty temp tree so no global defaultProfile is
		// found. A named profile keys XDG on the profile subdirectory instead, which
		// is a different code path from the one under test here.
		fs.mkdirSync(tempRoot, { recursive: true });
		process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), tempRoot);
		dataHome = path.join(tempRoot, "data");
		stateHome = path.join(tempRoot, "state");
		cacheHome = path.join(tempRoot, "cache");
		// The resolver only adopts an XDG root that already exists, so each has to be
		// created before it will be used.
		for (const home of [dataHome, stateHome, cacheHome]) {
			fs.mkdirSync(path.join(home, APP_NAME), { recursive: true });
		}
		process.env.XDG_DATA_HOME = dataHome;
		process.env.XDG_STATE_HOME = stateHome;
		process.env.XDG_CACHE_HOME = cacheHome;
		__resetDirsFromEnvForTests();
	});

	afterEach(() => {
		for (const key of KEYS) restoreEnv(key, saved[key]);
		__resetDirsFromEnvForTests();
		fs.rmSync(tempRoot, { recursive: true, force: true });
	});

	it("puts each category under the root that category names", () => {
		expect(getSessionsDir().startsWith(path.join(dataHome, APP_NAME))).toBe(true);
		expect(getStatsDbPath().startsWith(path.join(dataHome, APP_NAME))).toBe(true);
		expect(getLogsDir().startsWith(path.join(stateHome, APP_NAME))).toBe(true);
		expect(getPuppeteerDir().startsWith(path.join(cacheHome, APP_NAME))).toBe(true);
		expect(getDocsRsCacheDir().startsWith(path.join(cacheHome, APP_NAME))).toBe(true);
	});

	it("gives the same answer whichever category is asked for first", () => {
		// The memoization bug was order-dependent, so order is the thing to vary.
		const cacheFirst = { puppeteer: getPuppeteerDir(), logs: getLogsDir(), sessions: getSessionsDir() };
		__resetDirsFromEnvForTests();
		const dataFirst = { sessions: getSessionsDir(), logs: getLogsDir(), puppeteer: getPuppeteerDir() };

		expect(dataFirst).toEqual(cacheFirst);
	});

	it("never resolves a cache path under the data root or the reverse", () => {
		// The concrete corruption: something durable written into a directory the
		// user is told is safe to delete.
		expect(getPuppeteerDir().startsWith(dataHome)).toBe(false);
		expect(getDocsRsCacheDir().startsWith(dataHome)).toBe(false);
		expect(getSessionsDir().startsWith(cacheHome)).toBe(false);
		expect(getStatsDbPath().startsWith(cacheHome)).toBe(false);
	});

	it("returns a stable path when the same getter is called twice", () => {
		// Memoization still has to memoize; keying on the category must not have
		// turned every call into a fresh resolution with a different answer.
		expect(getSessionsDir()).toBe(getSessionsDir());
		expect(getLogsDir()).toBe(getLogsDir());
		expect(getPuppeteerDir()).toBe(getPuppeteerDir());
	});
});

describe("XDG roots are only adopted once they exist", () => {
	let tempRoot = "";
	const saved: Record<string, string | undefined> = {};
	const KEYS = [
		"XDG_DATA_HOME",
		"XDG_STATE_HOME",
		"XDG_CACHE_HOME",
		"VEYYON_PROFILE",
		"VEYYON_CODING_AGENT_DIR",
		"VEYYON_CONFIG_DIR",
	];

	beforeEach(() => {
		for (const key of KEYS) saved[key] = process.env[key];
		delete process.env.VEYYON_PROFILE;
		delete process.env.VEYYON_CODING_AGENT_DIR;
		tempRoot = path.join(os.tmpdir(), "veyyon-xdg-absent", Snowflake.next());
		fs.mkdirSync(tempRoot, { recursive: true });
		process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), tempRoot);
	});

	afterEach(() => {
		for (const key of KEYS) restoreEnv(key, saved[key]);
		__resetDirsFromEnvForTests();
		fs.rmSync(tempRoot, { recursive: true, force: true });
	});

	it("ignores an XDG_DATA_HOME with no veyyon directory in it", () => {
		// Setting XDG_DATA_HOME is normal on many desktops. Adopting it before the
		// user has run the migration would move their data out from under them, so
		// the directory has to be there already. The XDG root is kept outside the
		// config root here, or the assertion would pass for the wrong reason.
		const xdgHome = path.join(tempRoot, "..", `${path.basename(tempRoot)}-xdg`);
		fs.mkdirSync(xdgHome, { recursive: true });
		process.env.XDG_DATA_HOME = xdgHome;
		delete process.env.XDG_STATE_HOME;
		delete process.env.XDG_CACHE_HOME;
		__resetDirsFromEnvForTests();

		try {
			expect(getSessionsDir().startsWith(xdgHome)).toBe(false);
		} finally {
			fs.rmSync(xdgHome, { recursive: true, force: true });
		}
	});

	it("adopts XDG_DATA_HOME once the veyyon directory is there", () => {
		// The positive twin: the check above must be gating on the directory
		// existing, not on XDG being ignored altogether.
		const xdgHome = path.join(tempRoot, "..", `${path.basename(tempRoot)}-xdg-present`);
		fs.mkdirSync(path.join(xdgHome, APP_NAME), { recursive: true });
		process.env.XDG_DATA_HOME = xdgHome;
		delete process.env.XDG_STATE_HOME;
		delete process.env.XDG_CACHE_HOME;
		__resetDirsFromEnvForTests();

		try {
			expect(getSessionsDir().startsWith(path.join(xdgHome, APP_NAME))).toBe(true);
		} finally {
			fs.rmSync(xdgHome, { recursive: true, force: true });
		}
	});
});
