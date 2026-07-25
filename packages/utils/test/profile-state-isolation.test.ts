import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetDirsFromEnvForTests,
	getAgentDir,
	getHistoryDbPath,
	getSessionsDir,
	getStatsDbPath,
} from "@veyyon/utils/dirs";
import { removeWithRetries } from "../src/temp";
import { assertIsolatedAppPath, guardDestructivePath } from "./helpers/destructive-guard";

/**
 * PROF-3: sessions, history and stats are per-profile state, and unlike
 * credentials they have NO sharing posture — they are isolated unconditionally.
 * A user who keeps a client profile separate expects that profile's transcripts
 * and prompt history to be invisible from another one; a leak here exposes the
 * literal text of past conversations, which is worse than exposing a token in
 * one respect: it cannot be revoked.
 *
 * These assertions are on the REAL path resolvers rather than on a mock, because
 * the isolation is entirely a property of how the paths are built. Every path is
 * additionally run through `assertIsolatedAppPath` before it is written to, after
 * a guard defect let a sibling suite write into the developer's real config root
 * (see the SAFETY DOCTRINE note about Bun's cached `os.homedir()`).
 */
describe("per-profile state never leaks across profiles", () => {
	let tempRoot = "";
	const KEYS = [
		"XDG_DATA_HOME",
		"XDG_STATE_HOME",
		"XDG_CACHE_HOME",
		"XDG_CONFIG_HOME",
		"VEYYON_PROFILE",
		"VEYYON_CONFIG_DIR",
		"VEYYON_CODING_AGENT_DIR",
	];
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of KEYS) saved[key] = process.env[key];
		for (const key of KEYS) delete process.env[key];
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-profstate-"));
		// The config root is redirected through the app's own override, since
		// assigning process.env.HOME would not move `os.homedir()` in Bun.
		process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), tempRoot);
		__resetDirsFromEnvForTests();
		assertIsolatedAppPath(getAgentDir(), "profile-state-isolation");
	});

	afterEach(async () => {
		for (const key of KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		__resetDirsFromEnvForTests();
		if (tempRoot) {
			await removeWithRetries(guardDestructivePath(tempRoot, "profile-state-isolation"));
			tempRoot = "";
		}
	});

	/** Activate `profile` (undefined = default) and return its resolved, guarded paths. */
	function activate(profile: string | undefined): { sessions: string; history: string; stats: string } {
		if (profile === undefined) delete process.env.VEYYON_PROFILE;
		else process.env.VEYYON_PROFILE = profile;
		__resetDirsFromEnvForTests();
		return {
			sessions: assertIsolatedAppPath(getSessionsDir(), "profile-state-isolation"),
			history: assertIsolatedAppPath(getHistoryDbPath(), "profile-state-isolation"),
			stats: assertIsolatedAppPath(getStatsDbPath(), "profile-state-isolation"),
		};
	}

	/** Write a session transcript into `dir` and return its path. */
	function writeSession(dir: string, id: string, text: string): string {
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `${id}.jsonl`);
		fs.writeFileSync(file, `${JSON.stringify({ role: "user", content: text })}\n`);
		return file;
	}

	it("a session written in profile A is not present in profile B's sessions directory", () => {
		const a = activate("work");
		writeSession(a.sessions, "secret-session", "client billing details");

		const b = activate("client");

		// Different directories is the mechanism; an empty listing is the observable
		// consequence. Assert BOTH, so a future change that merges the directories but
		// happens to filter the listing still fails here.
		expect(b.sessions).not.toBe(a.sessions);
		expect(fs.existsSync(b.sessions) ? fs.readdirSync(b.sessions) : []).toEqual([]);

		// And A's file is still exactly where it was, with its exact content.
		expect(fs.readFileSync(path.join(a.sessions, "secret-session.jsonl"), "utf8")).toBe(
			`${JSON.stringify({ role: "user", content: "client billing details" })}\n`,
		);
	});

	it("history and stats databases are distinct files per profile", () => {
		const a = activate("work");
		const b = activate("client");

		// Sharing a history db would put one profile's typed prompts into another's
		// recall, which is a transcript leak through a side door.
		expect(a.history).not.toBe(b.history);
		expect(a.stats).not.toBe(b.stats);
	});

	it("every per-profile path lives under that profile's own directory", () => {
		for (const profile of ["work", "client"]) {
			const resolved = activate(profile);
			const profileRoot = path.join(tempRoot, "profiles", profile);
			for (const [name, target] of Object.entries(resolved)) {
				const rel = path.relative(profileRoot, path.resolve(target));
				// Containment, stated per path: no `..` escape, no absolute re-root.
				expect({ name, escapes: rel.startsWith("..") || path.isAbsolute(rel) }).toEqual({ name, escapes: false });
			}
		}
	});

	it("the default profile is itself a profile, not the bare config root", () => {
		const def = activate(undefined);

		// The legacy layout kept the default profile's state at the bare root, which
		// made "default" special-cased everywhere and let it collide with global
		// cross-profile files. Every profile including the default now lives under
		// `profiles/`.
		expect(def.sessions).toContain(`${path.sep}profiles${path.sep}default${path.sep}`);
		expect(path.resolve(def.sessions)).not.toBe(path.resolve(tempRoot));
	});

	it("switching back to a profile returns the SAME paths, so state is not stranded", () => {
		const first = activate("work");
		activate("client");
		const second = activate("work");

		// Path resolution must be deterministic across switches: a profile whose
		// directory moved between activations would strand every earlier session.
		expect(second).toEqual(first);
	});

	it("writes in two profiles land in two files, neither overwriting the other", () => {
		const a = activate("work");
		writeSession(a.sessions, "shared-id", "from work");
		const b = activate("client");
		writeSession(b.sessions, "shared-id", "from client");

		// Deliberately the SAME session id in both profiles: if the directories
		// collided, the second write would silently clobber the first and this asserts
		// the exact surviving content on both sides.
		expect(fs.readFileSync(path.join(a.sessions, "shared-id.jsonl"), "utf8")).toContain("from work");
		expect(fs.readFileSync(path.join(b.sessions, "shared-id.jsonl"), "utf8")).toContain("from client");
	});
});
