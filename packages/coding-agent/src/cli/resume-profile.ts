/**
 * The profile a launch that resumes or forks a session continues in.
 *
 * A session lives under the profile that wrote it (`profiles/<name>/agent/sessions/`), and the
 * `veyyon --resume <id>` line printed on exit states no profile. This module resolves the id against
 * every profile before any profile-scoped module loads, so `runCli` can activate the session's profile
 * ahead of its settings, credentials and `.env`. A fork is resolved the same way, so an unpinned
 * `--fork <id>` writes the new session under the profile that owns its source.
 *
 * The argv is read by the launch parser itself (`--resume`, `-r`, `--session`, `--continue <id>`,
 * `--fork`), and an id is matched against transcript filenames in each profile's sessions directory:
 * first at the top two levels (loose transcripts and one project directory deep), then, when no
 * profile holds it there, at any depth, which reaches a subagent transcript nested inside its
 * session's own directory. The lookup covers everything the session listing resolves, so an unpinned
 * resume or fork never reaches the listing's other-profile match.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	getAgentDir,
	getProfileSessionsDir,
	listProfiles,
	normalizePathForComparison,
	type ProfileInfo,
	pathIsWithin,
} from "@veyyon/utils/dirs";
import { isSessionFileName, sessionFileMatchesResumeArgument } from "@veyyon/utils/session-file";
import { resolveCliArgv } from "../cli-commands";
import { type Args, namesSessionFile, normalizeContinueSessionArgs, parseArgs } from "./args";

/**
 * The session id or file the launch resumes or forks, as the launch parser reads `argv`.
 *
 * Undefined for a subcommand, a launch that resumes nothing, and a launch whose `--no-session` or
 * `--session-dir` takes precedence over the resume. `--fork` takes precedence over `--resume`, as it
 * does when the launch builds its session. An argv the parser rejects is also undefined here; the
 * launch reports the same error when it parses the argv itself.
 */
export function resumedSessionArgument(argv: readonly string[]): string | undefined {
	const resolved = resolveCliArgv([...argv]);
	if ("error" in resolved || resolved.argv[0] !== "launch") return undefined;
	const launchArgv = resolved.argv.slice(1);
	let parsed: Args;
	try {
		parsed = parseArgs(launchArgv);
	} catch {
		return undefined;
	}
	normalizeContinueSessionArgs(parsed, launchArgv);
	if (parsed.noSession || parsed.sessionDir) return undefined;
	if (parsed.fork) return parsed.fork;
	return typeof parsed.resume === "string" ? parsed.resume : undefined;
}

/**
 * Whether a profile's sessions directory holds a transcript the id names: at the top two levels, or at
 * any depth when `deep` is set.
 *
 * A directory that cannot be read counts as holding nothing: the session listing scans the same
 * directories when the launch resolves the id and reports an unreadable one there.
 */
function holdsSession(profile: ProfileInfo, sessionId: string, deep: boolean): boolean {
	const root = getProfileSessionsDir(profile.name);
	const matches = (name: string): boolean =>
		isSessionFileName(name) && sessionFileMatchesResumeArgument(name, sessionId);
	if (deep) {
		try {
			return fs
				.readdirSync(root, { recursive: true, encoding: "utf8" })
				.some(entry => matches(path.basename(entry)));
		} catch {
			return false;
		}
	}
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return false;
	}
	for (const entry of entries) {
		if (entry.isFile()) {
			if (matches(entry.name)) return true;
			continue;
		}
		if (!entry.isDirectory()) continue;
		let names: string[];
		try {
			names = fs.readdirSync(path.join(root, entry.name));
		} catch {
			continue;
		}
		if (names.some(matches)) return true;
	}
	return false;
}

/**
 * The profile to activate for a launch that resumes or forks a session, or undefined to keep the
 * active one.
 *
 * The session's profile is the one whose sessions directory holds its file: for a path, the profile
 * the path is inside; for an id, the active profile when it holds a match, otherwise the first other
 * profile that does, in `listProfiles` order, with the two-level scan of every profile tried before
 * the deep one. An agent directory set outside every profile is kept, since no profile is active to
 * switch from.
 */
export function resumedSessionProfile(argv: readonly string[], cwd: string): string | undefined {
	const sessionArg = resumedSessionArgument(argv);
	if (sessionArg === undefined) return undefined;
	const profiles = listProfiles();
	const activeAgentDir = normalizePathForComparison(getAgentDir());
	const active = profiles.find(profile => normalizePathForComparison(profile.agentDir) === activeAgentDir);
	if (!active) return undefined;
	let holder: ProfileInfo | undefined;
	if (namesSessionFile(sessionArg)) {
		const file = path.resolve(cwd, sessionArg);
		holder = profiles.find(profile => pathIsWithin(getProfileSessionsDir(profile.name), file));
	} else {
		for (const deep of [false, true]) {
			if (holdsSession(active, sessionArg, deep)) break;
			holder = profiles.find(profile => profile !== active && holdsSession(profile, sessionArg, deep));
			if (holder) break;
		}
	}
	return holder && holder !== active ? holder.name : undefined;
}
