import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai";
import { type AuthBrokerServerHandle, startAuthBroker } from "@veyyon/ai/auth-broker";
import { runAuthBrokerCommand } from "@veyyon/coding-agent/cli/auth-broker-cli";
import {
	__resetDirsFromEnvForTests,
	getActiveAuthDbPath,
	getAgentDbPath,
	getSharedAuthDir,
	removeWithRetries,
	setAgentDir,
} from "@veyyon/utils";
import { captureDirOverrides, type DirOverridesSnapshot, restoreDirOverrides } from "@veyyon/utils/dirs";

const TEAM_ORG = "org-team-1111";

async function runMigrateCapturingStdout(): Promise<string> {
	const originalWrite = process.stdout.write.bind(process.stdout);
	let captured = "";
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		await runAuthBrokerCommand({
			action: "migrate",
			flags: { fromLocal: true, includeOauth: true },
		});
	} finally {
		process.stdout.write = originalWrite;
	}
	return captured;
}

describe("auth-broker migrate (org-only dedupe)", () => {
	let agentDir = "";
	let brokerAgentDir = "";
	let configRoot = "";
	let dirOverrides: DirOverridesSnapshot;
	let brokerStore: SqliteAuthCredentialStore | undefined;
	let brokerStorage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	const token = "broker-migrate-bearer";
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(async () => {
		savedEnv.VEYYON_AUTH_BROKER_URL = process.env.VEYYON_AUTH_BROKER_URL;
		savedEnv.VEYYON_AUTH_BROKER_TOKEN = process.env.VEYYON_AUTH_BROKER_TOKEN;
		savedEnv.VEYYON_CONFIG_DIR = process.env.VEYYON_CONFIG_DIR;
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-migrate-client-"));
		brokerAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-migrate-broker-"));
		configRoot = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-migrate-config-"));
		// `migrate --from-local` reads the LOCAL side through the shared credential
		// store, which lives under the CONFIG root, not the agent dir. Moving only
		// the agent dir left it reading the user's real credentials and uploading
		// them to a test broker — the same missed root as the import suite.
		process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), configRoot);
		// `setAgentDir` writes `VEYYON_CODING_AGENT_DIR` and this block's env snapshot
		// did not include it, so the temp agent dir stayed exported to every file that
		// ran after this one. `scripts/find-test-leaks.ts` caught it; the pair below is
		// the only restore that can put an ABSENT variable back.
		dirOverrides = captureDirOverrides();
		setAgentDir(agentDir);
		__resetDirsFromEnvForTests();

		brokerStore = await SqliteAuthCredentialStore.open(path.join(brokerAgentDir, "agent.db"));
		brokerStorage = new AuthStorage(brokerStore);
		await brokerStorage.reload();
		handle = startAuthBroker({
			storage: brokerStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
		process.env.VEYYON_AUTH_BROKER_URL = handle.url;
		process.env.VEYYON_AUTH_BROKER_TOKEN = token;
	});

	afterEach(async () => {
		await handle?.close();
		brokerStorage?.close();
		brokerStore?.close();
		for (const key of ["VEYYON_AUTH_BROKER_URL", "VEYYON_AUTH_BROKER_TOKEN", "VEYYON_CONFIG_DIR"] as const) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		restoreDirOverrides(dirOverrides);
		await removeWithRetries(agentDir);
		await removeWithRetries(brokerAgentDir);
		await removeWithRetries(configRoot);
	});

	test("every credential root this suite touches resolves inside a temp dir", () => {
		// Per root, for the reason the import suite learned the hard way: an
		// isolation assertion only proves the one path it names, and this suite
		// migrates CREDENTIALS, so a missed root uploads the user's real logins to a
		// throwaway broker.
		expect(getAgentDbPath().startsWith(os.tmpdir())).toBe(true);
		expect(getSharedAuthDir().startsWith(os.tmpdir())).toBe(true);
		expect(getActiveAuthDbPath().startsWith(os.tmpdir())).toBe(true);
	});

	test("rerun skips an already-migrated org-only row instead of re-uploading a stale refresh token", async () => {
		// Local row where login recovered neither email nor account: the org id
		// is the only identity the broker snapshot can echo back.
		const localStore = await SqliteAuthCredentialStore.open(getActiveAuthDbPath());
		try {
			localStore.upsertAuthCredentialForProvider("anthropic", {
				type: "oauth",
				access: "access-local",
				refresh: "refresh-local-stale",
				expires: Date.now() + 3_600_000,
				orgId: TEAM_ORG,
				orgName: "Team",
			});
		} finally {
			localStore.close();
		}

		const firstRun = await runMigrateCapturingStdout();
		expect(firstRun).toContain("uploaded");
		const uploaded = brokerStore!.getOAuth("anthropic");
		expect(uploaded?.refresh).toBe("refresh-local-stale");
		expect(uploaded?.orgId).toBe(TEAM_ORG);

		// The broker rotates the token after migration — its copy is now newer
		// than the local one.
		brokerStore!.upsertAuthCredentialForProvider("anthropic", {
			type: "oauth",
			access: "access-rotated",
			refresh: "refresh-rotated",
			expires: Date.now() + 7_200_000,
			orgId: TEAM_ORG,
			orgName: "Team",
		});
		await brokerStorage!.reload();

		// Rerun: the org-only row must be recognized as already migrated, not
		// re-uploaded (which would clobber the broker's newer refresh token).
		const secondRun = await runMigrateCapturingStdout();
		expect(secondRun).toContain("already on broker");
		expect(secondRun).toContain("Nothing to migrate");
		const persisted = brokerStore!.getOAuth("anthropic");
		expect(persisted?.refresh).toBe("refresh-rotated");
		expect(brokerStore!.listAuthCredentials("anthropic")).toHaveLength(1);
	});
});
