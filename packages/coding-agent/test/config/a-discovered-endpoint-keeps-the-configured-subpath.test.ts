/**
 * WHY: `normalizeOllamaBaseUrl` in `packages/coding-agent/src/config/model-discovery.ts` returned
 * `${parsed.protocol}//${parsed.host}`, discarding the path. An Ollama reached through a reverse
 * proxy is mounted at a subpath, so a configured `http://gateway:11434/ollama` was probed at
 * `http://gateway:11434/api/tags`, where nothing answers, and discovery reported no models. The
 * catalog's own Ollama discovery kept the path and worked, so the same endpoint was reachable or not
 * depending on which layer asked.
 *
 * THE CLASS: a base-URL normalizer that keeps only the origin. Every other normalizer in this module
 * already preserved the path; Ollama was the one that did not, and one test for the reported provider
 * would not have found it. This suite drives the production dispatcher over every discovery type the
 * config schema accepts, gives each a subpath, and requires every URL it fetches to stay under it.
 *
 * It fails by default on a new member twice over: the discovery types come from the arktype schema at
 * run time, and the covered set is checked against the module's own exported `discover*` names.
 *
 * WHAT IT DOES NOT CATCH: a normalizer that keeps the path but mangles it — a doubled segment, a
 * dropped trailing component — which the returned URLs would still start with the prefix for.
 */

import { describe, expect, it } from "bun:test";
import type { DiscoveryContext, DiscoveryProviderConfig } from "@veyyon/coding-agent/config/model-discovery";
import * as discovery from "@veyyon/coding-agent/config/model-discovery";
import type { ProviderDiscovery } from "@veyyon/coding-agent/config/models-config-schema";
import { modelsConfigSchemas } from "@veyyon/coding-agent/config/models-config-schema";

const HOST = "http://gateway.example:11434";
const PREFIX = `${HOST}/behind/a/proxy`;

/** One JSON body every discovery parser in this module tolerates. */
const PAYLOAD = {
	data: [{ id: "probe-model", name: "probe-model" }],
	models: [{ name: "probe-model", model: "probe-model" }],
};

/**
 * `discoverLlamaCppModelRuntimeMetadata` takes no caller-configured base URL: it receives a `Model`
 * whose `baseUrl` a discovery function above has already normalized.
 */
const NOT_BASE_URL_CONFIGURED: string[] = ["discoverLlamaCppModelRuntimeMetadata"];

/** Every discovery type the models config accepts, read out of the schema rather than restated. */
function discoveryTypes(): string[] {
	const expression = modelsConfigSchemas().ProviderDiscoverySchema.expression;
	const quoted = expression.match(/"[^"]+"/g) ?? [];
	return quoted.map(token => token.slice(1, -1)).sort();
}

function recordingContext(seen: string[]): DiscoveryContext {
	return {
		fetch: async input => {
			seen.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			return new Response(JSON.stringify(PAYLOAD), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
		getBearerApiKeyResolver: async () => undefined,
	};
}

async function probeUrls(config: DiscoveryProviderConfig): Promise<string[]> {
	const seen: string[] = [];
	await discovery.discoverModelsByProviderType(config, recordingContext(seen)).catch(() => []);
	return seen;
}

function configFor(type: string, baseUrl?: string): DiscoveryProviderConfig {
	return {
		provider: "local",
		api: "openai-completions",
		...(baseUrl === undefined ? {} : { baseUrl }),
		discovery: { type } as ProviderDiscovery,
	};
}

describe("every discovery entry point keeps the configured subpath", () => {
	it("reaches every discovery function through the dispatcher", () => {
		const exported: Readonly<Record<string, unknown>> = discovery;
		const found = Object.keys(exported)
			.filter(name => /^discover[A-Z]/.test(name))
			.sort();
		const dispatcherReached = [
			"discoverLiteLLMModels",
			"discoverLlamaCppModels",
			"discoverModelsByProviderType",
			"discoverOllamaModels",
			"discoverOpenAIModelsList",
			"discoverProxyModels",
		];
		expect(found, "a new discovery function needs a dispatcher case or an explicit opt-out").toEqual(
			[...dispatcherReached, ...NOT_BASE_URL_CONFIGURED].sort(),
		);
	});

	it("sweeps every discovery type the config schema accepts", () => {
		expect(discoveryTypes()).toEqual(["litellm", "llama.cpp", "lm-studio", "ollama", "openai-models-list", "proxy"]);
	});

	it.each(discoveryTypes())("%s probes only under the subpath", async type => {
		const seen = await probeUrls(configFor(type, PREFIX));

		expect(seen.length, `${type} fetched nothing, so it proves nothing`).toBeGreaterThan(0);
		for (const url of seen) {
			expect(url, `${type} left the configured subpath`).toStartWith(PREFIX);
		}
	});

	it.each(discoveryTypes())("%s keeps the subpath when the base URL already carries a /v1", async type => {
		const seen = await probeUrls(configFor(type, `${PREFIX}/v1`));

		expect(seen.length).toBeGreaterThan(0);
		for (const url of seen) {
			expect(url, `${type} left the configured subpath`).toStartWith(PREFIX);
		}
	});

	it("asks Ollama's own API for the tag list under the subpath", async () => {
		expect(await probeUrls(configFor("ollama", PREFIX))).toContain(`${PREFIX}/api/tags`);
	});

	it("still defaults to the loopback endpoint when no base URL is configured", async () => {
		expect(await probeUrls(configFor("ollama"))).toContain("http://127.0.0.1:11434/api/tags");
	});
});
