/**
 * One owner for "which directory holds a project's veyyon files", proven from the secrets side.
 *
 * WHY THIS SUITE EXISTS. The project-local config directory has exactly one definition,
 * `CONFIG_DIR_NAME` in `@veyyon/utils/dirs`, and every other subsystem joins against it
 * (`getProjectAgentDir`, `getProjectPersonalitiesDir`, the discovery roots, the omfg rule writer).
 * The secrets subsystem spelled the same directory as the bare literal `".veyyon"` in three
 * separate loaders instead: the declaration loader, the environment-keyword loader, and the vault
 * location resolver. Three copies of one name is three chances to drift, and the failure mode is
 * silent in the worst possible direction: a project's `secrets.yml` and its keyword extension
 * simply stop being found, no error is raised because a missing file legitimately means "nothing
 * declared", and the values the operator declared secret start flowing to the provider verbatim.
 *
 * WHAT EACH TEST PINS. Every path below is built from `CONFIG_DIR_NAME` rather than from the
 * literal, so the suite fails the moment a loader stops agreeing with the shared constant. Pinning
 * the literal instead would prove nothing: it would pass whether or not the loaders were unified.
 * The negative twin (a sibling directory that is NOT the config dir) is what stops the positive
 * tests from passing under a loader that reads any directory it can find.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadSecrets } from "@veyyon/coding-agent/secrets";
import {
	buildEnvSecretPattern,
	ENV_KEYWORDS_FILENAME,
	loadEnvSecretKeywords,
} from "@veyyon/coding-agent/secrets/env-keywords";
import { resolveVaultLocations } from "@veyyon/coding-agent/secrets/vault";
import { CONFIG_DIR_NAME } from "@veyyon/utils";

/** Long enough to clear the eight-character obfuscation floor, so acceptance is about the path. */
const DECLARED_VALUE = "sk-live-project-scoped-abcdefgh";

let cwd: string;
let agentDir: string;

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-secrets-configdir-cwd-"));
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-secrets-configdir-agent-"));
});

afterEach(async () => {
	await fs.rm(cwd, { recursive: true, force: true });
	await fs.rm(agentDir, { recursive: true, force: true });
});

/** Write one file under the project's config directory, creating it. */
async function writeInConfigDir(filename: string, contents: string): Promise<string> {
	const dir = path.join(cwd, CONFIG_DIR_NAME);
	await fs.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, filename);
	await fs.writeFile(filePath, contents);
	return filePath;
}

describe("the declaration loader reads the shared project config directory", () => {
	/**
	 * The positive contract: a declaration written under `CONFIG_DIR_NAME` is loaded.
	 *
	 * Locks out the drift where `loadSecrets` keeps a private `".veyyon"` while the shared constant
	 * moves. The consequence of that drift is not an error, it is an empty entry list and a
	 * credential sent to the provider in plain text.
	 */
	it("loads a declaration written under CONFIG_DIR_NAME", async () => {
		await writeInConfigDir("secrets.yml", `- type: plain\n  content: ${DECLARED_VALUE}\n`);

		const entries = await loadSecrets(cwd, agentDir);

		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ type: "plain", origin: "config", content: DECLARED_VALUE });
	});

	/**
	 * The negative twin: a directory that is not the config directory is not read.
	 *
	 * Without this, a loader that scanned the project root, or globbed for any `secrets.yml`, would
	 * satisfy the positive test while reading files the operator never meant as declarations.
	 */
	it("ignores a secrets.yml sitting in a sibling directory of the config dir", async () => {
		const decoy = path.join(cwd, `${CONFIG_DIR_NAME}-backup`);
		await fs.mkdir(decoy, { recursive: true });
		await fs.writeFile(path.join(decoy, "secrets.yml"), `- type: plain\n  content: ${DECLARED_VALUE}\n`);
		await fs.writeFile(path.join(cwd, "secrets.yml"), `- type: plain\n  content: ${DECLARED_VALUE}\n`);

		expect(await loadSecrets(cwd, agentDir)).toEqual([]);
	});

	/**
	 * The refusal names the resolved path, and that path is built from the shared constant.
	 *
	 * `loadSecrets` fails closed on a malformed file and quotes the file it read. That message is
	 * how an operator finds the file to fix, so it must name the directory the loader actually
	 * opened rather than a hardcoded guess at it.
	 */
	it("names the CONFIG_DIR_NAME path when the project declaration is malformed", async () => {
		const filePath = await writeInConfigDir("secrets.yml", "not: an array\n");

		const failure = await loadSecrets(cwd, agentDir).then(
			() => undefined,
			(error: unknown) => error,
		);

		if (!(failure instanceof Error)) throw new Error("loadSecrets resolved, but the file it read is malformed.");
		expect(failure.message).toContain(filePath);
		expect(filePath).toBe(path.join(cwd, CONFIG_DIR_NAME, "secrets.yml"));
	});
});

describe("the environment-keyword loader reads the same project config directory", () => {
	/**
	 * A project keyword extension under `CONFIG_DIR_NAME` reaches the compiled matcher.
	 *
	 * Asserting the keyword landed in the list is not enough: the list exists only to build the
	 * name pattern, so the test drives the pattern and pins both a name it must now match and a
	 * name the boundary rule must still exclude.
	 */
	it("adds a keyword declared under CONFIG_DIR_NAME and applies the boundary rule to it", async () => {
		await writeInConfigDir(ENV_KEYWORDS_FILENAME, "keywords:\n  - SCANSEED\n");

		const keywords = await loadEnvSecretKeywords({ cwd, agentDir });
		const pattern = buildEnvSecretPattern(keywords);

		expect(keywords).toContain("SCANSEED");
		expect(pattern.test("DEPLOY_SCANSEED")).toBe(true);
		expect(pattern.test("SCANSEEDER")).toBe(false);
	});

	/**
	 * The negative twin for the keyword loader.
	 *
	 * A keyword file outside the config directory must not widen detection. Detection widening is
	 * the failure mode that shreds ordinary prose, so a stray file must not be able to cause it.
	 */
	it("ignores a keyword file in a sibling directory of the config dir", async () => {
		const decoy = path.join(cwd, `${CONFIG_DIR_NAME}-backup`);
		await fs.mkdir(decoy, { recursive: true });
		await fs.writeFile(path.join(decoy, ENV_KEYWORDS_FILENAME), "keywords:\n  - SCANSEED\n");

		const keywords = await loadEnvSecretKeywords({ cwd, agentDir });

		expect(keywords).not.toContain("SCANSEED");
		expect(buildEnvSecretPattern(keywords).test("DEPLOY_SCANSEED")).toBe(false);
	});
});

describe("every secrets loader resolves the same project directory", () => {
	/**
	 * The three project-directory owners must name one directory, byte for byte.
	 *
	 * This is the cross-module half of the fix, and the one that catches the site this suite does
	 * not itself edit: the vault resolver. If any of the three drifts, a secret stored by `/secret`
	 * lands in a directory the session's declaration loader never opens, which reads to an operator
	 * as "the vault randomly does not work" rather than as a path bug.
	 */
	it("agrees with the vault resolver on the project directory", async () => {
		const declarationPath = await writeInConfigDir("secrets.yml", `- type: plain\n  content: ${DECLARED_VALUE}\n`);
		const keywordPath = await writeInConfigDir(ENV_KEYWORDS_FILENAME, "keywords:\n  - SCANSEED\n");
		const locations = resolveVaultLocations({ globalConfigRoot: path.join(cwd, "root"), agentDir, cwd });

		expect(locations.projectDir).toBe(path.join(cwd, CONFIG_DIR_NAME));
		expect(path.dirname(declarationPath)).toBe(locations.projectDir);
		expect(path.dirname(keywordPath)).toBe(locations.projectDir);
	});

	/**
	 * The profile-scoped files stay in the agent directory and never move into the config dir.
	 *
	 * The unification is about the PROJECT path only. A change that routed the profile file through
	 * `CONFIG_DIR_NAME` too would break every existing profile, so the asymmetry is pinned here
	 * rather than left to be rediscovered.
	 */
	it("keeps the profile declaration in the agent directory, not the config dir", async () => {
		await fs.writeFile(path.join(agentDir, "secrets.yml"), `- type: plain\n  content: ${DECLARED_VALUE}\n`);
		await fs.mkdir(path.join(agentDir, CONFIG_DIR_NAME), { recursive: true });
		await fs.writeFile(
			path.join(agentDir, CONFIG_DIR_NAME, "secrets.yml"),
			"- type: plain\n  content: never-read-from-here\n",
		);

		const entries = await loadSecrets(cwd, agentDir);

		expect(entries).toHaveLength(1);
		expect(entries[0].content).toBe(DECLARED_VALUE);
	});
});
