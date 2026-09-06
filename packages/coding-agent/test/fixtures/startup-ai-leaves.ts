import assert from "node:assert/strict";
import * as path from "node:path";

export function assertNoAiBarrelEvaluated(): void {
	const aiBarrels = Object.keys(require.cache).filter(file =>
		path.normalize(file).endsWith(path.join("packages", "ai", "src", "index.ts")),
	);
	assert.deepEqual(aiBarrels, [], "startup evaluated the AI package barrel");
}
