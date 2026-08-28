/**
 * WHY: `migrateLegacyDefaultProfileLayout` moves every entry of the config root
 * it does not exempt into `profiles/default/`. Three cross-profile paths sit at
 * that same root and are owned by THIS package, not by the module holding the
 * exemption table: the global `AGENTS.md`, the global vault, and the vault key.
 * Sweeping any of them into one profile takes it away from every other profile,
 * and the key takes every sealed credential in every scope with it.
 *
 * THE CLASS: a base-root path declared through this package's own accessors and
 * missing from the exemption table in `@veyyon/utils/dirs`. The sibling suite
 * `packages/utils/test/global-config.test.ts` pins the table by name; this one
 * pins it against the accessors, so a rename on either side goes red.
 *
 * NOT CAUGHT: a NEW base-root accessor added to this package. Nothing here can
 * discover one — the paths below are a list a reviewer extends. A base-root
 * path that reaches neither list is swept silently.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetDirsFromEnvForTests,
	getAgentDir,
	getGlobalConfigRootDir,
	migrateLegacyDefaultProfileLayout,
} from "@veyyon/utils/dirs";
import { Snowflake } from "@veyyon/utils/snowflake";
import { getGlobalAgentsPath } from "../../src/discovery/agents-guidance";
import { resolveVaultLocations, vaultPathFor } from "../../src/secrets/vault";
import { vaultKeyPath } from "../../src/secrets/vault-crypto";

let tempRoot = "";
let originalConfigDir: string | undefined;
let originalProfile: string | undefined;

beforeEach(() => {
	originalConfigDir = process.env.VEYYON_CONFIG_DIR;
	originalProfile = process.env.VEYYON_PROFILE;
	delete process.env.VEYYON_PROFILE;
	tempRoot = path.join(os.tmpdir(), `veyyon-legacy-sweep-${Snowflake.next()}`);
	fs.mkdirSync(tempRoot, { recursive: true });
	// VEYYON_CONFIG_DIR is the config dir NAME relative to home, so this lands the
	// global config root inside the temp tree.
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

/** Every base-root path this package owns, taken from the accessors themselves. */
function crossProfilePaths(): { label: string; filePath: string }[] {
	const root = getGlobalConfigRootDir();
	const locations = resolveVaultLocations({
		globalConfigRoot: root,
		agentDir: getAgentDir(),
		cwd: path.join(tempRoot, "project"),
	});
	return [
		{ label: "global AGENTS.md", filePath: getGlobalAgentsPath() },
		{ label: "global vault", filePath: vaultPathFor(locations, "global") },
		{ label: "vault key", filePath: vaultKeyPath(root) },
	];
}

describe("the legacy migration never moves cross-profile state", () => {
	it("leaves every base-root path this package owns at the root", () => {
		const root = getGlobalConfigRootDir();
		const owned = crossProfilePaths();
		// Each one must actually BE at the base root, or this suite is testing nothing.
		for (const { label, filePath } of owned) {
			expect(`${label}: ${path.dirname(filePath)}`).toBe(`${label}: ${root}`);
			fs.writeFileSync(filePath, `${label} contents`);
		}
		// A legacy layout with real data, so the migration runs rather than no-ops.
		fs.mkdirSync(path.join(root, "agent"), { recursive: true });
		fs.writeFileSync(path.join(root, "agent", "agent.db"), "db");

		const result = migrateLegacyDefaultProfileLayout();

		expect(result.migrated).toBe(true);
		for (const { label, filePath } of owned) {
			expect(`${label}: ${fs.existsSync(filePath)}`).toBe(`${label}: true`);
			expect(fs.readFileSync(filePath, "utf8")).toBe(`${label} contents`);
			expect(result.movedEntries).not.toContain(path.basename(filePath));
			// And no copy landed inside the profile, which would be a second owner.
			expect(fs.existsSync(path.join(result.targetDir, path.basename(filePath)))).toBe(false);
		}
	});

	it("still moves the legacy profile's own state past those exemptions", () => {
		const root = getGlobalConfigRootDir();
		for (const { label, filePath } of crossProfilePaths()) fs.writeFileSync(filePath, label);
		fs.mkdirSync(path.join(root, "agent"), { recursive: true });
		fs.writeFileSync(path.join(root, "agent", "agent.db"), "db");
		fs.writeFileSync(path.join(root, "stats.db"), "stats");

		const result = migrateLegacyDefaultProfileLayout();

		// The exemptions are not a blanket stand-down: legacy state still moves.
		expect(result.movedEntries).toEqual(["agent", "stats.db"]);
		expect(fs.readFileSync(path.join(result.targetDir, "agent", "agent.db"), "utf8")).toBe("db");
	});
});
