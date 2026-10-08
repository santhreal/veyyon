/**
 * A launch that resumes or forks a session continues in the profile that wrote it.
 *
 * WHY THIS SUITE EXISTS. `veyyon --resume <id>` states no profile, and the id
 * resolves from any profile's sessions root, so the session opened under
 * whichever profile the launch started in: its settings, credentials and `.env`
 * came from a profile the session never belonged to. An unpinned `--fork <id>`
 * skipped the lookup altogether and wrote a copy of another profile's session
 * under the profile the launch started in. `runCli` resolves the id against
 * every profile through `src/cli/resume-profile.ts` before any profile-scoped
 * module loads and activates the profile that holds it.
 *
 * THE CLASS THIS CLOSES is a resume or fork spelling that skips the lookup. The
 * sweep takes the launch parser's own resume flags from `OPTIONAL_FLAGS`, spaced
 * and `=`-joined, plus `--fork`, `--continue <id>`, `-c <id>`, a transcript path
 * and the id of a subagent transcript nested inside its session's directory, and
 * runs each against every owner and active profile pair, so a resume flag added
 * to the table is swept the day it lands. The negative controls are the
 * precedence rules: an explicit `--profile` (beside `--resume` or `--fork`),
 * `--no-session`, `--session-dir` and an id nobody wrote all keep the profile
 * the launch started in.
 *
 * WHAT IT DOES NOT CATCH: each launch runs with `--help`, so nothing here proves
 * the resumed session then opens; `main-cross-project-resume.test.ts` covers
 * that, and `session/a-session-belongs-to-the-profile-that-wrote-it.test.ts`
 * covers the fork a pinned `--profile` makes. A resume flag added outside
 * `OPTIONAL_FLAGS` and `--fork` is not swept.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	__resetProfileSnapshotForTests,
	getActiveProfile,
	getAgentDir,
	getSessionsDir,
	listProfiles,
	setAgentDir,
	setProfile,
} from "@veyyon/utils/dirs";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../utils/test/helpers/isolated-config-root";
import { runCli } from "../src/cli";
import { OPTIONAL_FLAGS } from "../src/cli/flag-tables";

const PROFILES = ["default", "oss", "work"] as const;
type ProfileName = (typeof PROFILES)[number];
/** Where a profile stores its sessions. XDG is a Linux and macOS convention the resolver ignores elsewhere. */
const LAYOUTS = process.platform === "win32" ? (["home"] as const) : (["home", "xdg"] as const);

/** One session per profile; the 8-character prefixes differ so a prefix names one session. */
const SESSION_IDS: Record<ProfileName, string> = {
	default: "019f0001-aaaa-7000-8000-000000000001",
	oss: "019f0002-bbbb-7000-8000-000000000002",
	work: "019f0003-cccc-7000-8000-000000000003",
};

const UNKNOWN_ID = "019f00ff-dead-7000-8000-0000000000ff";

/** One subagent transcript per profile, nested inside its session's own directory. */
const NESTED_IDS: Record<ProfileName, string> = {
	default: "019f0011-dddd-7000-8000-000000000011",
	oss: "019f0012-eeee-7000-8000-000000000012",
	work: "019f0013-ffff-7000-8000-000000000013",
};

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

for (const layout of LAYOUTS) {
	describe(`sessions stored under ${layout === "home" ? "the profile's agent dir" : "XDG_DATA_HOME"}`, () => {
		beforeEach(() => {
			originalProfile = getActiveProfile();
			originalAgentDir = getAgentDir();
			originalAgentDirEnv = process.env.VEYYON_CODING_AGENT_DIR;
			originalProfileEnv = process.env.VEYYON_PROFILE;
			isolated = enterIsolatedConfigRoot("resume-profile", { defaultProfile: true });
			sessionFiles.clear();
			if (layout === "xdg") {
				// `DirResolver` stores the default profile's data under `$XDG_DATA_HOME/veyyon` and a named
				// profile's under `$XDG_DATA_HOME/veyyon/profiles/<name>`, each once that directory exists.
				const xdgData = path.join(isolated.root, "xdg-data");
				process.env.XDG_DATA_HOME = xdgData;
				for (const profile of PROFILES) {
					const appDir = path.join(xdgData, "veyyon");
					fs.mkdirSync(profile === "default" ? appDir : path.join(appDir, "profiles", profile), {
						recursive: true,
					});
				}
			}
			for (const profile of PROFILES) {
				fs.mkdirSync(path.join(isolated.root, "profiles", profile, "agent"), { recursive: true });
				// Seeded where a process running the profile writes its sessions.
				activate(profile);
				const dir = path.join(getSessionsDir(), "-project");
				fs.mkdirSync(dir, { recursive: true });
				const id = SESSION_IDS[profile];
				const file = path.join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
				const nestedDir = path.join(dir, `2026-01-01T00-00-00-000Z_${id}`, "subagents");
				fs.mkdirSync(nestedDir, { recursive: true });
				const nestedId = NESTED_IDS[profile];
				fs.writeFileSync(
					path.join(nestedDir, `2026-01-01T00-00-01-000Z_${nestedId}.jsonl`),
					`${JSON.stringify({ type: "session", id: nestedId, cwd: isolated.root })}\n`,
				);
				fs.writeFileSync(file, `${JSON.stringify({ type: "session", id, cwd: isolated.root })}\n`);
				sessionFiles.set(profile, file);
			}
			// The seeded layout is the one the resolver lists, or every assertion below is vacuous.
			expect(listProfiles().map(entry => entry.name)).toEqual([...PROFILES]);
			// Under XDG the sessions leave the agent dir, or this layout proves nothing the other does not.
			for (const profile of PROFILES) {
				expect(sessionFiles.get(profile)?.startsWith(agentDirOf(profile)), profile).toBe(layout === "home");
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

		/** Every argv spelling that resumes or forks the session `owner` wrote. */
		function resumeSpellings(owner: ProfileName): { name: string; argv: string[] }[] {
			const id = SESSION_IDS[owner];
			const prefix = id.slice(0, 8);
			const spellings: { name: string; argv: string[] }[] = [];
			for (const flag of [...Object.keys(OPTIONAL_FLAGS), "--fork"]) {
				spellings.push({ name: `${flag} <prefix>`, argv: [flag, prefix] });
				if (flag.startsWith("--")) spellings.push({ name: `${flag}=<prefix>`, argv: [`${flag}=${prefix}`] });
			}
			spellings.push({ name: "--continue <id>", argv: ["--continue", id] });
			spellings.push({ name: "-c <id>", argv: ["-c", id] });
			const file = sessionFiles.get(owner);
			if (!file) throw new Error(`no session seeded for ${owner}`);
			spellings.push({ name: "--resume <path>", argv: ["--resume", file] });
			spellings.push({ name: "--fork <path>", argv: ["--fork", file] });
			spellings.push({ name: "--resume <nested subagent id>", argv: ["--resume", NESTED_IDS[owner].slice(0, 8)] });
			spellings.push({ name: "--fork <nested subagent id>", argv: ["--fork", NESTED_IDS[owner].slice(0, 8)] });
			// --fork wins over --resume when the launch builds its session, so the fork's source decides.
			spellings.push({ name: "--fork beside --resume", argv: ["--fork", prefix, "--resume", UNKNOWN_ID] });
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
				{ name: "an explicit --profile beside --fork", argv: ["--profile", "work", "--fork", SESSION_IDS.oss] },
				{ name: "--no-session", argv: ["--resume", SESSION_IDS.oss, "--no-session"] },
				{ name: "--session-dir", argv: ["--resume", SESSION_IDS.oss, "--session-dir", "elsewhere"] },
				{ name: "--session-dir beside --fork", argv: ["--fork", SESSION_IDS.oss, "--session-dir", "elsewhere"] },
				{ name: "an id nobody wrote", argv: ["--resume", UNKNOWN_ID] },
				{ name: "a fork of an id nobody wrote", argv: ["--fork", UNKNOWN_ID] },
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
	});
}
