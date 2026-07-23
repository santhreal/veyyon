import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAuthBrokerConfig } from "@veyyon/ai/auth-broker";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

describe("resolveAuthBrokerConfig config discovery", () => {
	let agentDir = "";
	let configDirName = "";
	let configRoot = "";
	// Discovery also falls back to the machine-wide global config
	// (`~/<VEYYON_CONFIG_DIR>/config.yml`), so every test pins the config dir to
	// a per-test sandbox — otherwise a developer's real ~/.veyyon broker entry
	// would leak into (or break) these assertions.
	let suppressEnv: Record<string, string | undefined> = {};

	beforeEach(async () => {
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-broker-config-"));
		configDirName = `.veyyon-broker-discovery-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
		configRoot = path.join(os.homedir(), configDirName);
		suppressEnv = {
			VEYYON_AUTH_BROKER_URL: undefined,
			VEYYON_AUTH_BROKER_TOKEN: undefined,
			VEYYON_CONFIG_DIR: configDirName,
		};
	});

	afterEach(async () => {
		if (agentDir) {
			await removeWithRetries(agentDir);
			agentDir = "";
		}
		if (configRoot) {
			await fs.rm(configRoot, { recursive: true, force: true });
			configRoot = "";
		}
	});

	test("resolves broker URL and token from config.yaml when config.yml is absent", async () => {
		await Bun.write(
			path.join(agentDir, "config.yaml"),
			"auth.broker.url: https://yaml-broker.example/v1\nauth.broker.token: yaml-token\n",
		);

		await withEnv(suppressEnv, async () => {
			await expect(resolveAuthBrokerConfig({ agentDir })).resolves.toEqual({
				url: "https://yaml-broker.example/v1",
				token: "yaml-token",
			});
		});
	});

	test("prefers config.yml over config.yaml when both exist", async () => {
		await Bun.write(
			path.join(agentDir, "config.yaml"),
			"auth.broker.url: https://yaml-broker.example/v1\nauth.broker.token: yaml-token\n",
		);
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"auth.broker.url: https://yml-broker.example/v1\nauth.broker.token: yml-token\n",
		);

		await withEnv(suppressEnv, async () => {
			await expect(resolveAuthBrokerConfig({ agentDir })).resolves.toEqual({
				url: "https://yml-broker.example/v1",
				token: "yml-token",
			});
		});
	});

	test("falls back to the machine-wide global config when the profile has no broker keys", async () => {
		// The Settings UI's Global tab writes here (nested form); one machine-wide
		// entry must serve a profile whose own config is silent.
		await fs.mkdir(configRoot, { recursive: true });
		await Bun.write(
			path.join(configRoot, "config.yml"),
			"auth:\n  broker:\n    url: https://global-broker.example/v1\n    token: global-token\n",
		);

		await withEnv(suppressEnv, async () => {
			await expect(resolveAuthBrokerConfig({ agentDir })).resolves.toEqual({
				url: "https://global-broker.example/v1",
				token: "global-token",
			});
		});
	});

	test("the profile's own config overrides the global config per key", async () => {
		// Profile sets only the URL; the token still fills from the global file —
		// per-key precedence, not whole-file shadowing.
		await fs.mkdir(configRoot, { recursive: true });
		await Bun.write(
			path.join(configRoot, "config.yml"),
			"auth:\n  broker:\n    url: https://global-broker.example/v1\n    token: global-token\n",
		);
		await Bun.write(path.join(agentDir, "config.yml"), "auth.broker.url: https://profile-broker.example/v1\n");

		await withEnv(suppressEnv, async () => {
			await expect(resolveAuthBrokerConfig({ agentDir })).resolves.toEqual({
				url: "https://profile-broker.example/v1",
				token: "global-token",
			});
		});
	});

	test("returns null when neither profile nor global config names a broker", async () => {
		await withEnv(suppressEnv, async () => {
			await expect(resolveAuthBrokerConfig({ agentDir })).resolves.toBeNull();
		});
	});
});
