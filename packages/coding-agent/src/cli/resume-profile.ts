/**
 * The profile a launch that resumes a session continues in.
 *
 * A session lives under the profile that wrote it (`profiles/<name>/agent/sessions/`), and the
 * `veyyon --resume <id>` line printed on exit states no profile. This module resolves the id against
 * every profile before any profile-scoped module loads, so `runCli` can activate the session's profile
 * ahead of its settings, credentials and `.env`.
 *
 * The argv is read by the launch parser itself (`--resume`, `-r`, `--session`, `--continue <id>`), and
 * an id is matched against transcript filenames at the top two levels of each profile's sessions
 * directory: loose transcripts and one project directory deep. A subagent transcript nested inside a
 * session's own directory is not searched; resuming one by id still resolves later, in the active
 * profile's listing or its other-profile fallback, without the profile switch.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	getAgentDir,
	listProfiles,
	normalizePathForComparison,
	type ProfileInfo,
	pathIsWithin,
} from "@veyyon/utils/dirs";
import { isSessionFileName, sessionFileMatchesResumeArgument } from "@veyyon/utils/session-file";
import { resolveCliArgv } from "../cli-commands";
import { type Args, namesSessionFile, normalizeContinueSessionArgs, parseArgs } from "./args";

/**
 * The session id or file the launch resumes, as the launch parser reads `argv`.
 *
 * Undefined for a subcommand, a launch that resumes nothing, and a launch whose `--fork`,
 * `--no-session` or `--session-dir` takes precedence over the resume. An argv the parser rejects is
 * also undefined here; the launch reports the same error when it parses the argv itself.
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
	if (typeof parsed.resume !== "string" || parsed.fork || parsed.noSession || parsed.sessionDir) return undefined;
	return parsed.resume;
}

function sessionsRoot(profile: ProfileInfo): string {
	return path.join(profile.agentDir, "sessions");
}

/**
 * Whether a profile's sessions directory holds a transcript the id names.
 *
 * A directory that cannot be read counts as holding nothing: the session listing scans the same
 * directories when the launch resolves the id and reports an unreadable one there.
 */
function holdsSession(profile: ProfileInfo, sessionId: string): boolean {
	const root = sessionsRoot(profile);
	const matches = (name: string): boolean =>
		isSessionFileName(name) && sessionFileMatchesResumeArgument(name, sessionId);
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
 * The profile to activate for a launch that resumes a session, or undefined to keep the active one.
 *
 * The session's profile is the one whose sessions directory holds its file: for a path, the profile
 * the path is inside; for an id, the active profile when it holds a match, otherwise the first other
 * profile that does, in `listProfiles` order. An agent directory set outside every profile is kept,
 * since no profile is active to switch from.
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
		holder = profiles.find(profile => pathIsWithin(sessionsRoot(profile), file));
	} else if (!holdsSession(active, sessionArg)) {
		holder = profiles.find(profile => profile !== active && holdsSession(profile, sessionArg));
	}
	return holder && holder !== active ? holder.name : undefined;
}
