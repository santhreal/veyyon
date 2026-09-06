import assert from "node:assert/strict";
import * as path from "node:path";
import "../../src/session/agent-session";
import { listRegisteredUsageProviders, resolveRegisteredRankingStrategy } from "@veyyon/ai/usage/registry";
import { postmortem } from "@veyyon/utils";

try {
	const aiBarrels = Object.keys(require.cache).filter(file =>
		path.normalize(file).endsWith(path.join("packages", "ai", "src", "index.ts")),
	);
	assert.deepEqual(aiBarrels, [], "startup evaluated the AI package barrel");
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
