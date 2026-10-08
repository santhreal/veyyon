/**
 * Runs the model work of an interactive launch over the scratch directory argv[2] and prints, as JSON,
 * which bundled providers' catalog specs that work built into models.
 *
 * The launch work is the registry's startup discovery refresh (`refresh("online-if-uncached")`), the
 * usage-report collection the status line runs, and the construction of the session's `Agent` with
 * the model the session resolved. The session's model comes from the `models.yml` provider argv[3]
 * that the caller wrote into the scratch directory, and is resolved before the observed window, as a
 * launch resolves `--model` before its refresh. argv[4] is a comma-separated list of providers given
 * an API key before the launch, or empty.
 *
 * Building is observed at `buildModel`, the one function every catalog spec passes through to become
 * a model. Every request the launch makes is answered 404 at once: a thrown fetch is a transient
 * failure a discovery retries through its backoff, and a 404 is a final answer.
 */
import { spyOn } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import * as build from "@veyyon/catalog/build";
import { getBundledProviders } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";

export interface LaunchProviderBuilds {
	/** Bundled providers whose catalog specs the launch built into models, sorted. */
	built: string[];
	/** Catalog specs of bundled providers the launch built into models. */
	models: number;
}

const [dir, configProvider, keyed = ""] = process.argv.slice(2);
if (!dir || !configProvider) {
	throw new Error("usage: launch-provider-builds.ts <dir> <models.yml provider> [provider,provider,...]");
}
async function offline(input: string | URL | Request): Promise<Response> {
	return new Response(`launch-provider-builds reaches no network: ${String(input)}`, { status: 404 });
}
// Discovery, models.dev enrichment and usage reports each reach the network through their own fetch.
globalThis.fetch = Object.assign(offline, { preconnect: fetch.preconnect });
const authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
for (const provider of keyed.split(",").filter(Boolean)) {
	await authStorage.set(provider, { type: "api_key", key: `sk-test-${provider}` });
}
const registry = new ModelRegistry(authStorage, path.join(dir, "models.yml"), { snapshotIo: false, fetch: offline });
const model = registry.getProviderModels(configProvider)[0];
if (!model) throw new Error(`models.yml in ${dir} declares no model for ${configProvider}`);

const bundled = new Set<string>(getBundledProviders());
const built = new Set<string>();
let models = 0;
const buildModel = build.buildModel;
const spy = spyOn(build, "buildModel").mockImplementation(spec => {
	if (bundled.has(spec.provider)) {
		built.add(spec.provider);
		models++;
	}
	return buildModel(spec);
});

await registry.refresh("online-if-uncached");
await authStorage.fetchUsageReports?.({ baseUrlResolver: provider => registry.getProviderBaseUrl(provider) });
const agent = new Agent({ initialState: { model } });
spy.mockRestore();
authStorage.close();
if (agent.state.model !== model) throw new Error("the launch's Agent lost the session's model");

const result: LaunchProviderBuilds = { built: [...built].sort(), models };
process.stdout.write(JSON.stringify(result));
