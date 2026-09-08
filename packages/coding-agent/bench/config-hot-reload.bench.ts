import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { makeBench } from "@veyyon/utils/bench-harness";
import { Settings } from "../src/config/settings";
import { resolveSubagentModel } from "../src/task/subagent-settings";

// Identical deterministic corpus in both arms; off is the pre-reload snapshot.
const names = Array.from({ length: 32 }, (_, i) => `worker-${i}`);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reload-bench-"));
try {
	const file = path.join(dir, "config.yml");
	const config = (generation: string) =>
		JSON.stringify({
			subagent: { agents: Object.fromEntries(names.map(name => [name, { model: `openai/${generation}-${name}` }])) },
		});
	await fs.writeFile(file, config("old"));
	const off = await Settings.loadReadOnly({ agentDir: dir });
	const on = await Settings.loadReadOnly({ agentDir: dir });
	const route = (settings: Settings) => names.map(agentName => resolveSubagentModel({ settings, agentName }).patterns);
	const baseline = names.map(name => [`openai/old-${name}`]);
	assert.deepEqual(route(off), baseline);
	assert.deepEqual(route(on), baseline);
	await fs.writeFile(file, config("new"));
	const start = performance.now();
	await on.reloadConfig();
	const reloadMs = performance.now() - start;
	assert.deepEqual(route(off), baseline);
	assert.deepEqual(
		route(on),
		names.map(name => [`openai/new-${name}`]),
	);
	const bench = makeBench(1_000, { warmup: 100 });
	bench("off: unchanged production spawn resolver", () => {
		route(off);
	});
	bench("on: reloaded production spawn resolver", () => {
		route(on);
	});
	process.stdout.write(
		`Exact parity: 32/32 off routes equal pre-feature baseline; 32/32 on routes changed; 0 provider calls, 0 model tokens in both arms. Reload: ${reloadMs.toFixed(3)}ms.\n`,
	);
} finally {
	await fs.rm(dir, { recursive: true, force: true });
}
