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

const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);

function silenceStdout(): () => string {
	let captured = "";
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
	return () => captured;
}

describe("auth-broker import (CLIProxyAPI)", () => {
	let agentDir = "";
	let cliproxyDir = "";
	let configRoot = "";
	let dirOverrides: DirOverridesSnapshot;
	// `setAgentDir` writes VEYYON_CODING_AGENT_DIR; VEYYON_CONFIG_DIR moves the
	// separate CONFIG root. Snapshot both so a tempdir override cannot leak into
	// tests that run after this file in the same process.
	let originalEnv: Array<[string, string | undefined]> = [];

	beforeEach(async () => {
		originalEnv = ["VEYYON_CODING_AGENT_DIR", "VEYYON_CONFIG_DIR"].map(key => [key, process.env[key]]);
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-import-agent-"));
		cliproxyDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-import-cliproxy-"));
		configRoot = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-import-config-"));
		// THE ROOT THIS SUITE ORIGINALLY MISSED. `import` writes to the machine-wide
		// SHARED credential store, which lives under the CONFIG root
		// (`getSharedAuthDir()` -> `<config root>/shared-auth`) — a root `setAgentDir`
		// does not touch. Moving only the agent dir left the import writing real
		// credentials to the user's own `~/.veyyon/shared-auth/agent.db` while the
		// assertions read an empty temp db, which is why they saw zero rows.
		//
		// VEYYON_CONFIG_DIR is resolved RELATIVE TO os.homedir(), and in Bun
		// os.homedir() is fixed at process start, so assigning HOME here would do
		// nothing. A relative path from the real home to the temp root is the way to
		// move it.
		process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), configRoot);
		// `setAgentDir` writes `VEYYON_CODING_AGENT_DIR` and this block's env snapshot
		// did not include it, so the temp agent dir stayed exported to every file that
		// ran after this one. `scripts/test-sandbox/find-test-leaks.ts` caught it; the pair below is
		// the only restore that can put an ABSENT variable back.
		dirOverrides = captureDirOverrides();
		setAgentDir(agentDir);
		__resetDirsFromEnvForTests();
	});

	afterEach(async () => {
		process.stdout.write = ORIGINAL_STDOUT_WRITE;
		for (const [key, value] of originalEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		restoreDirOverrides(dirOverrides);
		await removeWithRetries(agentDir);
		await removeWithRetries(cliproxyDir);
		await removeWithRetries(configRoot);
	});

	test("every credential root this suite touches resolves inside a temp dir", () => {
		// The assertion that would have caught the original defect immediately, and
		// the reason it is stated per ROOT rather than once: an isolation check only
		// proves the one path it names, and this suite passed for a long time while
		// naming only the agent db.
		expect(getAgentDbPath().startsWith(os.tmpdir())).toBe(true);
		expect(getSharedAuthDir().startsWith(os.tmpdir())).toBe(true);
		expect(getActiveAuthDbPath().startsWith(os.tmpdir())).toBe(true);
	});

	async function writeCliProxyJson(name: string, body: Record<string, unknown>): Promise<string> {
		const file = path.join(cliproxyDir, name);
		await Bun.write(file, JSON.stringify(body));
		return file;
	}

	test("imports a directory of CLIProxyAPI JSONs and maps types to veyyon providers", async () => {
		await writeCliProxyJson("claude-sample.json", {
			type: "claude",
			access_token: "claude-access-1",
			refresh_token: "claude-refresh-1",
			expired: "2099-12-31T23:59:59Z",
			email: "claude-user@example.com",
			id_token: "ignored",
			last_refresh: "2025-01-01T00:00:00Z",
		});
		await writeCliProxyJson("codex-sample.json", {
			type: "codex",
			access_token: "codex-access-1",
			refresh_token: "codex-refresh-1",
			expired: "2099-12-31T23:59:59Z",
			email: "codex-user@example.com",
			account_id: "acct-codex-1",
			websockets: true,
		});
		await writeCliProxyJson("disabled.json", {
			type: "claude",
			access_token: "x",
			refresh_token: "y",
			expired: "2099-12-31T23:59:59Z",
			email: "disabled@example.com",
			disabled: true,
		});

		const restore = silenceStdout();
		await runAuthBrokerCommand({
			action: "import",
			flags: { source: cliproxyDir, json: false },
		});
		restore();

		const store = await SqliteAuthCredentialStore.open(getActiveAuthDbPath());
		try {
			const claude = store.listAuthCredentials("anthropic");
			expect(claude).toHaveLength(1);
			expect(claude[0].credential.type).toBe("oauth");
			if (claude[0].credential.type === "oauth") {
				expect(claude[0].credential.access).toBe("claude-access-1");
				expect(claude[0].credential.refresh).toBe("claude-refresh-1");
				expect(claude[0].credential.email).toBe("claude-user@example.com");
				expect(claude[0].credential.expires).toBe(Date.parse("2099-12-31T23:59:59Z"));
			}

			const codex = store.listAuthCredentials("openai-codex");
			expect(codex).toHaveLength(1);
			if (codex[0].credential.type === "oauth") {
				expect(codex[0].credential.access).toBe("codex-access-1");
				expect(codex[0].credential.accountId).toBe("acct-codex-1");
			}

			// disabled.json was skipped by default
			const disabled = store
				.listAuthCredentials("anthropic")
				.find(r => r.credential.type === "oauth" && r.credential.email === "disabled@example.com");
			expect(disabled).toBeUndefined();
		} finally {
			store.close();
		}
	});

	test("dry-run does not write any credentials", async () => {
		await writeCliProxyJson("claude.json", {
			type: "claude",
			access_token: "a",
			refresh_token: "b",
			expired: "2099-12-31T23:59:59Z",
			email: "dryrun@example.com",
		});

		const restore = silenceStdout();
		await runAuthBrokerCommand({
			action: "import",
			flags: { source: cliproxyDir, dryRun: true, json: true },
		});
		const output = restore();

		const store = await SqliteAuthCredentialStore.open(getActiveAuthDbPath());
		try {
			expect(store.listAuthCredentials()).toHaveLength(0);
		} finally {
			store.close();
		}
		const parsed = JSON.parse(output.trim().split("\n").pop() ?? "{}");
		expect(parsed.dryRun).toBe(true);
		expect(parsed.plan).toHaveLength(1);
		expect(parsed.plan[0].provider).toBe("anthropic");
	});

	test("--provider override forces a provider id when the JSON type is unrecognized", async () => {
		await writeCliProxyJson("weird.json", {
			type: "some-future-type",
			access_token: "z",
			refresh_token: "w",
			expired: "2099-12-31T23:59:59Z",
			email: "future@example.com",
		});

		const restore = silenceStdout();
		await runAuthBrokerCommand({
			action: "import",
			flags: { source: cliproxyDir, provider: "anthropic" },
		});
		restore();

		const store = await SqliteAuthCredentialStore.open(getActiveAuthDbPath());
		try {
			const rows = store.listAuthCredentials("anthropic");
			expect(rows).toHaveLength(1);
		} finally {
			store.close();
		}
	});

	test("--include-disabled imports rows marked disabled", async () => {
		await writeCliProxyJson("disabled.json", {
			type: "claude",
			access_token: "d",
			refresh_token: "e",
			expired: "2099-12-31T23:59:59Z",
			email: "disabled-import@example.com",
			disabled: true,
		});

		const restore = silenceStdout();
		await runAuthBrokerCommand({
			action: "import",
			flags: { source: cliproxyDir, includeDisabled: true },
		});
		restore();

		const store = await SqliteAuthCredentialStore.open(getActiveAuthDbPath());
		try {
			expect(store.listAuthCredentials("anthropic")).toHaveLength(1);
		} finally {
			store.close();
		}
	});
});

describe("auth-broker import (broker-routed)", () => {
	let agentDir = "";
	let brokerAgentDir = "";
	let cliproxyDir = "";
	let configRoot = "";
	let dirOverrides: DirOverridesSnapshot;
	let brokerStore: SqliteAuthCredentialStore | undefined;
	let brokerStorage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	const token = "broker-import-bearer";
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(async () => {
		savedEnv.VEYYON_AUTH_BROKER_URL = process.env.VEYYON_AUTH_BROKER_URL;
		savedEnv.VEYYON_AUTH_BROKER_TOKEN = process.env.VEYYON_AUTH_BROKER_TOKEN;
		savedEnv.VEYYON_CONFIG_DIR = process.env.VEYYON_CONFIG_DIR;
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-import-client-"));
		brokerAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-import-broker-"));
		cliproxyDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-import-cliproxy-broker-"));
		configRoot = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-import-broker-config-"));
		// Same missed root as the block above. This block's own assertion — that the
		// LOCAL store was not touched — reads the shared store under the CONFIG root,
		// so without moving it the test would open the user's real credential db to
		// prove a negative about it.
		process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), configRoot);
		// `setAgentDir` writes `VEYYON_CODING_AGENT_DIR` and this block's env snapshot
		// did not include it, so the temp agent dir stayed exported to every file that
		// ran after this one. `scripts/test-sandbox/find-test-leaks.ts` caught it; the pair below is
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
		await removeWithRetries(cliproxyDir);
		await removeWithRetries(configRoot);
	});

	test("every credential root this block touches resolves inside a temp dir", () => {
		// Stated per root here too. This block asserts a NEGATIVE about the local
		// store, and a negative assertion against the wrong database is the easiest
		// way to be reassured by nothing at all.
		expect(getAgentDbPath().startsWith(os.tmpdir())).toBe(true);
		expect(getSharedAuthDir().startsWith(os.tmpdir())).toBe(true);
		expect(getActiveAuthDbPath().startsWith(os.tmpdir())).toBe(true);
	});

	test("uploads CLIProxyAPI JSONs to the broker when configured, not the local store", async () => {
		await Bun.write(
			path.join(cliproxyDir, "claude-foo@bar.json"),
			JSON.stringify({
				type: "claude",
				access_token: "broker-access",
				refresh_token: "broker-refresh-real",
				expired: "2099-12-31T23:59:59Z",
				email: "foo@bar.com",
			}),
		);

		const ORIGINAL_STDOUT = process.stdout.write.bind(process.stdout);
		let captured = "";
		process.stdout.write = ((chunk: string | Uint8Array): boolean => {
			captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			await runAuthBrokerCommand({
				action: "import",
				flags: { source: cliproxyDir },
			});
		} finally {
			process.stdout.write = ORIGINAL_STDOUT;
		}

		// The broker received it (and persisted the real refresh token).
		const persisted = brokerStore!.getOAuth("anthropic");
		expect(persisted?.access).toBe("broker-access");
		expect(persisted?.refresh).toBe("broker-refresh-real");
		expect(persisted?.email).toBe("foo@bar.com");

		// The local client SQLite store was NOT touched.
		const localStore = await SqliteAuthCredentialStore.open(getActiveAuthDbPath());
		try {
			expect(localStore.listAuthCredentials()).toHaveLength(0);
		} finally {
			localStore.close();
		}

		expect(captured).toContain("uploaded");
		expect(captured).toContain(handle!.url);
	});

	test("dry-run does not upload even when broker is configured", async () => {
		await Bun.write(
			path.join(cliproxyDir, "claude-dry.json"),
			JSON.stringify({
				type: "claude",
				access_token: "a",
				refresh_token: "b",
				expired: "2099-12-31T23:59:59Z",
				email: "dry@example.com",
			}),
		);

		const ORIGINAL_STDOUT = process.stdout.write.bind(process.stdout);
		process.stdout.write = (() => true) as typeof process.stdout.write;
		try {
			await runAuthBrokerCommand({
				action: "import",
				flags: { source: cliproxyDir, dryRun: true },
			});
		} finally {
			process.stdout.write = ORIGINAL_STDOUT;
		}

		expect(brokerStore!.listAuthCredentials()).toHaveLength(0);
	});
});
