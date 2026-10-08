/**
 * The broker URL and token each come from the first source that sets them, and only a config value
 * that supplies the result is passed to the config resolver.
 *
 * The defect class: a precedence slip between the four sources (env var, profile config, global
 * config, token file), a config value that resolves to an empty string treated as set, and a config
 * value the result does not use passed to the resolver anyway. The coding agent's resolver runs a
 * `!command` value as a shell command, so the last one runs a credential helper at startup for a
 * value that is then discarded.
 *
 * The sweep crosses every subset of URL sources with every subset of token sources and derives the
 * expected result and the expected resolver calls from the precedence lists below. It does not
 * cover `!command` execution itself, which belongs to the resolver, or the `config.yml` over
 * `config.yaml` file-name order, which `auth-broker-config-discovery.test.ts` covers.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAuthBrokerTokenFilePath, resolveAuthBrokerConfig } from "@veyyon/ai/auth-broker";
import { getGlobalConfigRootDir } from "@veyyon/utils/dirs";
import { removeWithRetries } from "../../utils/src/temp";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../utils/test/helpers/isolated-config-root";
import { withEnv } from "./helpers";

/** Precedence order, highest first. */
const URL_SOURCES = ["env", "profile", "global"] as const;
/** Precedence order, highest first. */
const TOKEN_SOURCES = ["env", "profile", "global", "file"] as const;
type Source = (typeof TOKEN_SOURCES)[number];

interface SourceValues {
	url: Partial<Record<Source, string>>;
	token: Partial<Record<Source, string>>;
}

/** Every subset of `items`, each in the order of `items`. */
function subsets<T>(items: readonly T[]): T[][] {
	const out: T[][] = [];
	for (let mask = 0; mask < 1 << items.length; mask++) {
		out.push(items.filter((_, i) => (mask & (1 << i)) !== 0));
	}
	return out;
}

function urlFrom(source: Source): string {
	return `https://${source}-broker.example/v1`;
}

function tokenFrom(source: Source): string {
	return `${source}-token`;
}

async function writeText(filePath: string, text: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, text);
}

/** A resolver that records every value it receives and resolves a `blank:` value to an empty string. */
function recordingResolver(): { calls: string[]; resolve: (config: string) => Promise<string | undefined> } {
	const calls: string[] = [];
	return {
		calls,
		resolve: async config => {
			calls.push(config);
			return config.startsWith("blank:") ? "" : config;
		},
	};
}

describe("a broker setting comes from the first source that sets it", () => {
	let agentDir = "";
	let isolated: IsolatedConfigRoot | undefined;

	beforeEach(async () => {
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-broker-precedence-"));
		isolated = enterIsolatedConfigRoot("broker-precedence");
	});

	afterEach(async () => {
		await removeWithRetries(agentDir);
		agentDir = "";
		isolated?.restore();
		isolated = undefined;
	});

	/**
	 * Writes the profile config (flat keys), the global config (nested keys) and the token file with
	 * the values assigned to each, and returns the env overrides for the env-sourced values.
	 */
	async function writeSources(values: SourceValues): Promise<Record<string, string | undefined>> {
		const profile: string[] = [];
		if (values.url.profile) profile.push(`auth.broker.url: ${values.url.profile}`);
		if (values.token.profile) profile.push(`auth.broker.token: ${values.token.profile}`);
		if (profile.length > 0) await writeText(path.join(agentDir, "config.yml"), `${profile.join("\n")}\n`);

		const global: string[] = [];
		if (values.url.global) global.push(`    url: ${values.url.global}`);
		if (values.token.global) global.push(`    token: ${values.token.global}`);
		if (global.length > 0) {
			await writeText(path.join(getGlobalConfigRootDir(), "config.yml"), `auth:\n  broker:\n${global.join("\n")}\n`);
		}

		if (values.token.file) await writeText(getAuthBrokerTokenFilePath(), `${values.token.file}\n`);
		return { VEYYON_AUTH_BROKER_URL: values.url.env, VEYYON_AUTH_BROKER_TOKEN: values.token.env };
	}

	const combos = subsets(URL_SOURCES).flatMap(urlSources =>
		subsets(TOKEN_SOURCES).map(tokenSources => [
			urlSources.join("+") || "nowhere",
			tokenSources.join("+") || "nowhere",
			urlSources,
			tokenSources,
		]),
	) as [string, string, Source[], Source[]][];

	test.each(combos)("URL from %s, token from %s", async (_url, _token, urlSources, tokenSources) => {
		const env = await writeSources({
			url: Object.fromEntries(urlSources.map(source => [source, urlFrom(source)])),
			token: Object.fromEntries(tokenSources.map(source => [source, tokenFrom(source)])),
		});
		const resolver = recordingResolver();

		const winningUrl = urlSources[0];
		const winningToken = tokenSources[0];
		const expectedCalls: string[] = [];
		if (winningUrl !== undefined && winningUrl !== "env") expectedCalls.push(urlFrom(winningUrl));
		if (winningUrl !== undefined && (winningToken === "profile" || winningToken === "global")) {
			expectedCalls.push(tokenFrom(winningToken));
		}

		await withEnv(env, async () => {
			const result = resolveAuthBrokerConfig({ agentDir, configValueResolver: resolver.resolve });
			if (winningUrl === undefined) await expect(result).resolves.toBeNull();
			else if (winningToken === undefined) await expect(result).rejects.toThrow(/no bearer token/);
			else await expect(result).resolves.toEqual({ url: urlFrom(winningUrl), token: tokenFrom(winningToken) });
		});
		expect(resolver.calls).toEqual(expectedCalls);
	});

	test.each([
		["profile", { profile: "blank:url", global: urlFrom("global") }],
		["global", { global: "blank:url" }],
	] as const)("a %s URL that resolves to an empty string leaves no broker configured", async (_source, url) => {
		const env = await writeSources({ url, token: { env: tokenFrom("env") } });
		const resolver = recordingResolver();
		await withEnv(env, async () => {
			await expect(resolveAuthBrokerConfig({ agentDir, configValueResolver: resolver.resolve })).resolves.toBeNull();
		});
		expect(resolver.calls).toEqual(["blank:url"]);
	});

	test.each([
		["profile", { profile: "blank:token", global: tokenFrom("global"), file: tokenFrom("file") }],
		["global", { global: "blank:token", file: tokenFrom("file") }],
	] as const)(
		"a %s token that resolves to an empty string falls through to the token file",
		async (_source, token) => {
			const env = await writeSources({ url: { env: urlFrom("env") }, token });
			const resolver = recordingResolver();
			await withEnv(env, async () => {
				await expect(resolveAuthBrokerConfig({ agentDir, configValueResolver: resolver.resolve })).resolves.toEqual(
					{
						url: urlFrom("env"),
						token: tokenFrom("file"),
					},
				);
			});
			expect(resolver.calls).toEqual(["blank:token"]);
		},
	);

	test("a token that resolves to an empty string with no token file fails naming every token source", async () => {
		const env = await writeSources({ url: { env: urlFrom("env") }, token: { profile: "blank:token" } });
		const resolver = recordingResolver();
		await withEnv(env, async () => {
			await expect(resolveAuthBrokerConfig({ agentDir, configValueResolver: resolver.resolve })).rejects.toThrow(
				/VEYYON_AUTH_BROKER_TOKEN.*auth\.broker\.token.*auth-broker\.token/,
			);
		});
	});
});
