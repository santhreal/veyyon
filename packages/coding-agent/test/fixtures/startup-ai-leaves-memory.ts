import assert from "node:assert/strict";
import * as path from "node:path";
import { listRegisteredUsageProviders, resolveRegisteredRankingStrategy } from "@veyyon/ai/usage/registry";
import { postmortem } from "@veyyon/utils";
import { Settings } from "../../src/config/settings";
import { resolveMemoryBackend } from "../../src/memory/resolve";

try {
	const backend = await resolveMemoryBackend(Settings.isolated({ "memory.backend": "mnemopi" }));
	assert.equal(backend.id, "mnemopi");
	const aiBarrels = Object.keys(require.cache).filter(file =>
		path.normalize(file).endsWith(path.join("packages", "ai", "src", "index.ts")),
	);
	assert.deepEqual(aiBarrels, [], "configured memory loading evaluated the AI package barrel");
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
