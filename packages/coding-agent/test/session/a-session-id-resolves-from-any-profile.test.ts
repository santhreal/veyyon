/**
 * The id veyyon prints on the way out resolves wherever the session was written.
 *
 * WHY THIS SUITE EXISTS. Exiting prints `veyyon --resume <id>`, and that line
 * carries nothing about which profile wrote the session. Every lookup stopped at
 * the ACTIVE profile's sessions root, so relaunching under any other profile
 * reported `Session "<id>" not found` with the file on disk one directory over.
 * The id is a UUIDv7 and already globally unique; what was profile-scoped was the
 * search, so the fix is the lookup and old ids keep working unchanged.
 *
 * THE CLASS THIS CLOSES is a globally unique name resolved through a partial
 * index. The sweep below builds a session in each profile and asserts every one
 * of them resolves from a different active profile, so a fourth profile layout —
 * or a root that stops being scanned — turns this red rather than failing for one
 * operator on one machine. The negative control is an id nobody wrote, which must
 * still miss: a search that answers everything is the same defect inverted.
 *
 * WHAT IT DOES NOT CATCH: it drives `resolveResumableSession`, so nothing here
 * proves the CLI passes the flag's value through unchanged, and nothing proves a
 * resumed foreign session keeps writing to its own profile's directory.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { resolveResumableSession } from "@veyyon/kernel/session/session-listing";
import { __resetDirsFromEnvForTests, Snowflake } from "@veyyon/utils";
import { makeAssistantMessage } from "../session-manager/helpers";

/** Profiles this sweep builds. `default` is the fixed first row of the roster. */
const PROFILES = ["default", "work", "oss"] as const;

let tempRoot: string;
let originalConfigDir: string | undefined;
let originalProfile: string | undefined;

beforeEach(() => {
	originalConfigDir = process.env.VEYYON_CONFIG_DIR;
	originalProfile = process.env.VEYYON_PROFILE;
	delete process.env.VEYYON_PROFILE;
	tempRoot = path.join(os.tmpdir(), `veyyon-resume-profiles-${Snowflake.next()}`);
	fs.mkdirSync(tempRoot, { recursive: true });
	// VEYYON_CONFIG_DIR is the config dir NAME relative to home, so this lands the
	// config root inside the temp tree.
	process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), tempRoot);
	__resetDirsFromEnvForTests();
});

afterEach(() => {
	if (originalConfigDir === undefined) delete process.env.VEYYON_CONFIG_DIR;
	else process.env.VEYYON_CONFIG_DIR = originalConfigDir;
	if (originalProfile === undefined) delete process.env.VEYYON_PROFILE;
	else process.env.VEYYON_PROFILE = originalProfile;
	__resetDirsFromEnvForTests();
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

/** Where a profile keeps the sessions for one project directory. */
function sessionDirFor(profile: string, project: string): string {
	return path.join(tempRoot, "profiles", profile, "agent", "sessions", project);
}

function activateProfile(profile: string): void {
	if (profile === "default") delete process.env.VEYYON_PROFILE;
	else process.env.VEYYON_PROFILE = profile;
	__resetDirsFromEnvForTests();
}

/** A session written into `profile`, answered so it reaches disk. Returns its id. */
async function seedSession(profile: string, project: string): Promise<string> {
	const dir = sessionDirFor(profile, project);
	fs.mkdirSync(dir, { recursive: true });
	const manager = SessionManager.create(dir, dir);
	manager.appendMessage({ role: "user", content: `a turn in ${profile}`, timestamp: 1 });
	manager.appendMessage(makeAssistantMessage());
	await manager.flush();
	return manager.getSessionId();
}

describe("a session id printed on exit", () => {
	it("resolves from every other profile, whichever one wrote it", async () => {
		const cwd = path.join(tempRoot, "project");
		fs.mkdirSync(cwd, { recursive: true });

		const ids = new Map<string, string>();
		for (const profile of PROFILES) {
			activateProfile(profile);
			ids.set(profile, await seedSession(profile, "-project"));
		}

		for (const active of PROFILES) {
			activateProfile(active);
			for (const [owner, id] of ids) {
				const match = await resolveResumableSession(id, cwd);
				expect(match, `${active} resolving the session ${owner} wrote`).toBeDefined();
				expect(match?.session.id).toBe(id);
				expect(fs.existsSync(match?.session.path ?? "")).toBe(true);
			}
		}
	});

	/** NEGATIVE CONTROL: a wider search that matches anything proves nothing. */
	it("still reports an id nobody wrote as missing", async () => {
		const cwd = path.join(tempRoot, "project");
		fs.mkdirSync(cwd, { recursive: true });
		activateProfile("work");
		await seedSession("work", "-project");

		expect(await resolveResumableSession("019000ff-dead-7000-8000-000000000000", cwd)).toBeUndefined();
	});
});
