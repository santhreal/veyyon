import { afterEach, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { reset as resetCapabilityCaches } from "@veyyon/coding-agent/capability";
import { getAgentDir, getGlobalConfigRootDir, getProfileRootDir, setProfile } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./settings-test-state";
import { useTrackedTempDirs } from "./tracked-temp-dir";

/**
 * Isolated on-disk fixture for the three context-file scopes.
 *
 * WHY THIS EXISTS. The scopes are resolved from PROCESS GLOBALS, not from
 * arguments: the global `AGENTS.md` path comes from `os.homedir()` plus the
 * config dir name, and the profile `AGENTS.md` path comes from the active
 * profile's agent dir. A suite that wants to prove "the global file reaches the
 * prompt" therefore has to move both of those somewhere disposable, or it is
 * reading (and, through the startup seeding of managed guidance headers,
 * WRITING) the developer's real `~/.veyyon`. That is the difference between a
 * test that measures the loader and a test that measures whatever the developer
 * happens to have installed.
 *
 * `process.env.HOME` alone is not enough: Bun resolves `os.homedir()` once per
 * process, so the assignment is invisible to `getGlobalConfigRootDir()`. The
 * `homedir` spy is what actually moves the global scope, and the env var is set
 * alongside it so any child logic reading `HOME` agrees with the spy.
 */
export interface ContextScopeFixture {
	/** Temp directory standing in for the developer's home. */
	home: string;
	/** `<home>/.veyyon`, the cross-profile global config root. */
	globalRoot: string;
	/** `<home>/.veyyon/AGENTS.md`, the GLOBAL scope file. */
	globalAgentsPath: string;
	/** Name of the profile activated for this fixture. */
	profile: string;
	/** Active profile's agent dir, `<home>/.veyyon/profiles/<profile>/agent`. */
	agentDir: string;
	/** `<agentDir>/AGENTS.md`, the PROFILE scope file. */
	profileAgentsPath: string;
	/** Repo root of the fixture workspace, carrying a `.git` marker. */
	repoRoot: string;
	/** Working directory used for the project walk, one level below the repo root. */
	cwd: string;
	/** `<repoRoot>/AGENTS.md`, project scope at depth 1. */
	rootAgentsPath: string;
	/** `<cwd>/AGENTS.md`, project scope at depth 0. */
	nestedAgentsPath: string;
	/** Agent dir of another, non-active profile under the same isolated home. */
	agentDirFor(profile: string): string;
	/** Write a file, creating parent directories first. Returns the absolute path. */
	writeFile(filePath: string, content: string): string;
	/** Drop every cached directory listing and file read from the capability layer. */
	resetCaches(): void;
}

/**
 * Register isolation for a suite and return a fixture factory.
 *
 * Mirrors `useTrackedTempDirs`: the teardown is attached to the act of creating
 * the fixture, so a case cannot forget it and leak the developer's real profile
 * into whichever suite runs next.
 */
export function useContextScopeFixture(prefix: string): (profile: string) => ContextScopeFixture {
	const makeHome = useTrackedTempDirs(prefix);
	let state: SettingsTestState | undefined;

	afterEach(() => {
		restoreSettingsTestState(state);
		state = undefined;
		// The capability layer memoizes every file read and directory listing by
		// absolute path. Leaving those entries in place would let one case's temp
		// tree answer the next case's lookups.
		resetCapabilityCaches();
	});

	return (profile: string): ContextScopeFixture => {
		state = beginSettingsTest();
		const home = makeHome();
		process.env.HOME = home;
		vi.spyOn(os, "homedir").mockReturnValue(home);
		setProfile(profile);
		resetCapabilityCaches();

		const globalRoot = getGlobalConfigRootDir();
		const agentDir = getAgentDir();
		const repoRoot = path.join(home, "workspace");
		const cwd = path.join(repoRoot, "pkg");
		fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });

		const writeFile = (filePath: string, content: string): string => {
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, content);
			return filePath;
		};

		return {
			home,
			globalRoot,
			globalAgentsPath: path.join(globalRoot, "AGENTS.md"),
			profile,
			agentDir,
			profileAgentsPath: path.join(agentDir, "AGENTS.md"),
			repoRoot,
			cwd,
			rootAgentsPath: path.join(repoRoot, "AGENTS.md"),
			nestedAgentsPath: path.join(cwd, "AGENTS.md"),
			agentDirFor: (other: string) => path.join(getProfileRootDir(other), "agent"),
			writeFile,
			resetCaches: resetCapabilityCaches,
		};
	};
}

/** Distinct, multi-paragraph scope bodies so no scope can be deduped into another. */
export const GLOBAL_BODY = [
	"# Global standing orders",
	"",
	"Every session obeys the cross-profile baseline recorded here.",
	"Marker: GLOBAL-SCOPE-BYTES-c3f1.",
].join("\n");

export const PROFILE_BODY = [
	"# Work profile orders",
	"",
	"This profile ships to production, so releases need a second reviewer.",
	"Marker: PROFILE-SCOPE-BYTES-9a27.",
].join("\n");

export const PROJECT_ROOT_BODY = [
	"# Repository rules",
	"",
	"The repo root sets the house style for every package below it.",
	"Marker: PROJECT-ROOT-BYTES-51bd.",
].join("\n");

export const PROJECT_NESTED_BODY = [
	"# Package rules",
	"",
	"This package overrides the house style with its own conventions.",
	"Marker: PROJECT-NESTED-BYTES-7e40.",
].join("\n");

/**
 * The rendered wrapper both prompt templates put around a context file.
 * Asserting on this exact shape is what makes "the bytes reached the prompt" a
 * claim about the assembled prompt rather than about a substring that could
 * equally have come from a file listing or a path echo.
 *
 * The renderer trims each file's content, so the expectation trims too rather
 * than asserting a trailing blank line the templates never emit.
 */
export function renderedContextBlock(filePath: string, content: string): string {
	return `<file path="${filePath}">\n${content.trim()}\n</file>`;
}
