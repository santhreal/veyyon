/**
 * A launch that resumes a session continues in the profile that wrote it.
 *
 * WHY THIS SUITE EXISTS. `veyyon --resume <id>` states no profile, and the id
 * resolves from any profile's sessions root, so the session opened under
 * whichever profile the launch started in: its settings, credentials and `.env`
 * came from a profile the session never belonged to. `runCli` resolves the id
 * against every profile before any profile-scoped module loads and activates the
 * profile that holds it.
 *
 * THE CLASS THIS CLOSES is a resume spelling that skips the lookup. The sweep
 * takes the launch parser's own resume flags from `OPTIONAL_FLAGS`, spaced and
 * `=`-joined, plus `--continue <id>`, `-c <id>` and a transcript path, and runs
 * each against every owner and active profile pair, so a resume flag added to the
 * table is swept the day it lands. The negative controls are the precedence
 * rules: an explicit `--profile`, a `--fork`, `--no-session`, `--session-dir` and
 * an id nobody wrote all keep the profile the launch started in.
 *
 * WHAT IT DOES NOT CATCH: each launch runs with `--help`, so nothing here proves
 * the resumed session then opens; `main-cross-project-resume.test.ts` covers
 * that. A transcript nested deeper than one project directory is not searched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	__resetProfileSnapshotForTests,
	getActiveProfile,
	getAgentDir,
	listProfiles,
	setAgentDir,
	setProfile,
} from "@veyyon/utils/dirs";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../utils/test/helpers/isolated-config-root";
import { runCli } from "../src/cli";
import { OPTIONAL_FLAGS } from "../src/cli/flag-tables";

const PROFILES = ["default", "oss", "work"] as const;
type ProfileName = (typeof PROFILES)[number];

/** One session per profile; the 8-character prefixes differ so a prefix names one session. */
const SESSION_IDS: Record<ProfileName, string> = {
	default: "019f0001-aaaa-7000-8000-000000000001",
	oss: "019f0002-bbbb-7000-8000-000000000002",
	work: "019f0003-cccc-7000-8000-000000000003",
};

const UNKNOWN_ID = "019f00ff-dead-7000-8000-0000000000ff";

let isolated: IsolatedConfigRoot | undefined;
let originalProfile: string | undefined;
let originalAgentDir = "";
let originalAgentDirEnv: string | undefined;
let originalProfileEnv: string | undefined;
const sessionFiles = new Map<ProfileName, string>();

function agentDirOf(profile: ProfileName): string {
	const info = listProfiles().find(entry => entry.name === profile);
	if (!info) throw new Error(`profile ${profile} is not listed`);
	return path.resolve(info.agentDir);
}

function activate(profile: ProfileName): void {
	setProfile(profile === "default" ? undefined : profile);
}

beforeEach(() => {
	originalProfile = getActiveProfile();
	originalAgentDir = getAgentDir();
	originalAgentDirEnv = process.env.VEYYON_CODING_AGENT_DIR;
	originalProfileEnv = process.env.VEYYON_PROFILE;
	isolated = enterIsolatedConfigRoot("resume-profile", { defaultProfile: true });
	sessionFiles.clear();
	for (const profile of PROFILES) {
		const dir = path.join(isolated.root, "profiles", profile, "agent", "sessions", "-project");
		fs.mkdirSync(dir, { recursive: true });
		const id = SESSION_IDS[profile];
		const file = path.join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
		fs.writeFileSync(file, `${JSON.stringify({ type: "session", id, cwd: isolated.root })}\n`);
		sessionFiles.set(profile, file);
	}
	// The seeded layout is the one the resolver lists, or every assertion below is vacuous.
	expect(listProfiles().map(entry => entry.name)).toEqual([...PROFILES]);
	for (const profile of PROFILES) {
		expect(sessionFiles.get(profile)?.startsWith(agentDirOf(profile))).toBe(true);
	}
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	process.exitCode = 0;
});

afterEach(() => {
	vi.restoreAllMocks();
	setProfile(undefined);
	if (originalProfile) setProfile(originalProfile);
	else if (originalAgentDirEnv !== undefined) setAgentDir(originalAgentDir);
	if (originalProfileEnv === undefined) delete process.env.VEYYON_PROFILE;
	else process.env.VEYYON_PROFILE = originalProfileEnv;
	if (originalAgentDirEnv === undefined) delete process.env.VEYYON_CODING_AGENT_DIR;
	else process.env.VEYYON_CODING_AGENT_DIR = originalAgentDirEnv;
	__resetProfileSnapshotForTests();
	process.exitCode = 0;
	isolated?.restore();
	isolated = undefined;
});

/** Every argv spelling that resumes the session `owner` wrote. */
function resumeSpellings(owner: ProfileName): { name: string; argv: string[] }[] {
	const id = SESSION_IDS[owner];
	const prefix = id.slice(0, 8);
	const spellings: { name: string; argv: string[] }[] = [];
	for (const flag of Object.keys(OPTIONAL_FLAGS)) {
		spellings.push({ name: `${flag} <prefix>`, argv: [flag, prefix] });
		if (flag.startsWith("--")) spellings.push({ name: `${flag}=<prefix>`, argv: [`${flag}=${prefix}`] });
	}
	spellings.push({ name: "--continue <id>", argv: ["--continue", id] });
	spellings.push({ name: "-c <id>", argv: ["-c", id] });
	const file = sessionFiles.get(owner);
	if (!file) throw new Error(`no session seeded for ${owner}`);
	spellings.push({ name: "--resume <path>", argv: ["--resume", file] });
	return spellings;
}

describe("a launch that resumes a session", () => {
	it("activates the profile that wrote it, for every resume spelling and every starting profile", async () => {
		const misses: string[] = [];
		for (const owner of PROFILES) {
			for (const spelling of resumeSpellings(owner)) {
				for (const active of PROFILES) {
					activate(active);
					await runCli([...spelling.argv, "--help"]);
					const landed = path.resolve(getAgentDir());
					if (landed !== agentDirOf(owner)) {
						misses.push(`${spelling.name} for ${owner}'s session from ${active} landed in ${landed}`);
					}
				}
			}
		}
		expect(misses).toEqual([]);
		expect(process.exitCode).toBe(0);
	});

	const KEEPS_ACTIVE: { name: string; argv: string[] }[] = [
		{ name: "an explicit --profile", argv: ["--profile", "work", "--resume", SESSION_IDS.oss] },
		{ name: "--fork beside --resume", argv: ["--fork", SESSION_IDS.oss, "--resume", SESSION_IDS.oss] },
		{ name: "--no-session", argv: ["--resume", SESSION_IDS.oss, "--no-session"] },
		{ name: "--session-dir", argv: ["--resume", SESSION_IDS.oss, "--session-dir", "elsewhere"] },
		{ name: "an id nobody wrote", argv: ["--resume", UNKNOWN_ID] },
	];

	for (const control of KEEPS_ACTIVE) {
		it(`keeps the starting profile under ${control.name}`, async () => {
			activate("work");
			await runCli([...control.argv, "--help"]);
			expect(path.resolve(getAgentDir())).toBe(agentDirOf("work"));
			expect(process.exitCode).toBe(0);
		});
	}
});
