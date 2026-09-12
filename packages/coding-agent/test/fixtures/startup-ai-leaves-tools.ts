import assert from "node:assert/strict";
import * as path from "node:path";
import { listRegisteredUsageProviders, resolveRegisteredRankingStrategy } from "@veyyon/ai/usage/registry";
import { postmortem } from "@veyyon/utils";
import { Settings } from "../../src/config/settings";
import { createTools } from "../../src/tools";
import { getSearchProvider, SEARCH_PROVIDER_ORDER } from "../../src/tools/web/search/provider";

try {
	const tools = await createTools({
		cwd: process.cwd(),
		hasUI: false,
		skipPythonPreflight: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"inspect_image.enabled": true,
			"web_search.enabled": true,
			"tools.discoveryMode": "off",
		}),
	});
	for (const name of ["inspect_image", "web_search"]) {
		assert.ok(
			tools.some(tool => tool.name === name),
			`${name} must be constructed before checking its imports`,
		);
	}
	for (const id of SEARCH_PROVIDER_ORDER) {
		assert.equal((await getSearchProvider(id)).id, id);
	}
	const aiBarrels = Object.keys(require.cache).filter(file =>
		path.normalize(file).endsWith(path.join("packages", "ai", "src", "index.ts")),
	);
	assert.deepEqual(aiBarrels, [], "tool construction evaluated the AI package barrel");
	const rankingProviders: string[] = JSON.parse(process.argv[2]);
	process.stdout.write(
		`${JSON.stringify({
			usageProviders: listRegisteredUsageProviders()
				.map(provider => provider.id)
				.sort(),
			rankingProviders: rankingProviders
				.filter(provider => resolveRegisteredRankingStrategy(provider) !== undefined)
				.sort(),
		})}\n`,
	);
} finally {
	await postmortem.cleanup();
}
