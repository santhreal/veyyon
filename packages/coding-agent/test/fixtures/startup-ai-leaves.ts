import assert from "node:assert/strict";
import * as path from "node:path";
import { listRegisteredUsageProviders, resolveRegisteredRankingStrategy } from "@veyyon/ai/usage/registry";
import { postmortem } from "@veyyon/utils";
import { warmRuntimeGraph } from "../../src/cli/runtime-warmup";

try {
	switch (process.argv[2]) {
		case "session":
			await import("../../src/session/agent-session");
			break;
		case "sdk":
			await import("../../src/sdk");
			break;
		case "warmup":
			await warmRuntimeGraph();
			break;
		default:
			throw new Error("A startup entry is required");
	}
	const aiBarrels = Object.keys(require.cache).filter(file =>
		path.normalize(file).endsWith(path.join("packages", "ai", "src", "index.ts")),
	);
	assert.deepEqual(aiBarrels, [], "startup evaluated the AI package barrel");
	const rankingProviders: string[] = JSON.parse(process.argv[3]);
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
