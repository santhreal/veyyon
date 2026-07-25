import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetDirsFromEnvForTests,
	getActiveAuthDbPath,
	getAgentDbPath,
	getSharedAuthDir,
	getSharedAuthStoreDirIfEnabled,
} from "@veyyon/utils/dirs";
import { Snowflake } from "@veyyon/utils/snowflake";

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

/**
 * `getActiveAuthDbPath` / `getSharedAuthStoreDirIfEnabled` are the single owner of
 * "which `agent.db` actually holds the current profile's credentials right now".
 *
 * The bug they lock out: with profile-sharing ON (the default), `discoverAuthStorage`
 * opens the machine-wide shared store `<configRoot>/shared-auth/agent.db`, but every
 * "credentials saved to …" / "stored credentials live in …" message used to print the
 * PER-PROFILE `getAgentDbPath()` — a sibling file that is EMPTY under sharing. A user
 * with working, shared credentials was told they lived in an empty file, which read as
 * login corruption. These tests pin that the message path equals the store path in both
 * postures, and specifically that under sharing it is NOT the per-profile sibling.
 */
describe("getActiveAuthDbPath names the file the store actually opens", () => {
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

	function writeGlobalConfig(contents: string | undefined): void {
		const file = path.join(tempRoot, "config.yml");
		if (contents === undefined) {
			fs.rmSync(file, { force: true });
		} else {
			fs.writeFileSync(file, contents);
		}
		__resetDirsFromEnvForTests();
	}

	beforeEach(() => {
		for (const key of KEYS) saved[key] = process.env[key];
		// Deterministic, ambient-independent roots: no XDG redirect, default profile.
		delete process.env.XDG_DATA_HOME;
		delete process.env.XDG_STATE_HOME;
		delete process.env.XDG_CACHE_HOME;
		delete process.env.VEYYON_PROFILE;
		delete process.env.VEYYON_CODING_AGENT_DIR;

		tempRoot = path.join(os.tmpdir(), "veyyon-active-auth", Snowflake.next());
		fs.mkdirSync(tempRoot, { recursive: true });
		// Point the config root at the temp tree the same way the XDG-category suite does:
		// VEYYON_CONFIG_DIR is the config dir NAME relative to home, so getBaseConfigRoot()
		// resolves back to exactly tempRoot.
		process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), tempRoot);
		__resetDirsFromEnvForTests();
	});

	afterEach(() => {
		for (const key of KEYS) restoreEnv(key, saved[key]);
		__resetDirsFromEnvForTests();
		fs.rmSync(tempRoot, { recursive: true, force: true });
	});

	it("with sharing ON (no config), points at the shared store, never the per-profile sibling", () => {
		writeGlobalConfig(undefined);

		const shared = getSharedAuthDir();
		expect(getSharedAuthStoreDirIfEnabled()).toBe(shared);

		const active = getActiveAuthDbPath();
		expect(active).toBe(path.join(shared, "agent.db"));
		expect(active).toBe(getAgentDbPath(shared));

		// The regression: the message path must NOT be the empty per-profile sibling.
		const perProfile = getAgentDbPath();
		expect(active).not.toBe(perProfile);
	});

	it("with an unrelated key present but profileSharing unset, still defaults to shared", () => {
		writeGlobalConfig("defaultProfile: default\n");

		const shared = getSharedAuthDir();
		expect(getSharedAuthStoreDirIfEnabled()).toBe(shared);
		expect(getActiveAuthDbPath()).toBe(path.join(shared, "agent.db"));
	});

	it("with profileSharing: false, isolates to the per-profile store", () => {
		writeGlobalConfig("profileSharing: false\n");

		expect(getSharedAuthStoreDirIfEnabled()).toBeUndefined();

		const active = getActiveAuthDbPath();
		expect(active).toBe(getAgentDbPath());
		// And distinct from the shared store the sharing-on case would use.
		expect(active).not.toBe(path.join(getSharedAuthDir(), "agent.db"));
	});

	it("on unreadable global config, fails safe to shared (never isolates by accident)", () => {
		// A broken config.yml must not silently flip the user into an isolated,
		// empty per-profile store — readGlobalProfileSharingSafe() defaults to true.
		writeGlobalConfig("profileSharing: [this is not a bool\n:::");

		expect(getSharedAuthStoreDirIfEnabled()).toBe(getSharedAuthDir());
		expect(getActiveAuthDbPath()).toBe(path.join(getSharedAuthDir(), "agent.db"));
	});

	it("an explicit agentDir arg is used only when sharing is off", () => {
		const custom = path.join(tempRoot, "custom-agent");

		// Sharing on: the shared store wins over any passed agentDir.
		writeGlobalConfig(undefined);
		expect(getActiveAuthDbPath(custom)).toBe(path.join(getSharedAuthDir(), "agent.db"));

		// Sharing off: the passed agentDir is honoured.
		writeGlobalConfig("profileSharing: false\n");
		expect(getActiveAuthDbPath(custom)).toBe(getAgentDbPath(custom));
	});
});
