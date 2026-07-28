import type { Api, Model } from "@veyyon/ai";
import { getBundledModels, getBundledProviders } from "@veyyon/catalog/models";
import type { ModelRegistry } from "../../packages/coding-agent/src/config/model-registry";
import {
	buildAuthAwareBrowserItems,
	cachedAuthAwareBrowserItems,
} from "../../packages/coding-agent/src/modes/components/model-selector";
import { sortModelItems } from "../../packages/coding-agent/src/modes/components/model-browser";

const ITERATIONS = 25;
const models = getBundledProviders().flatMap(
	provider => getBundledModels(provider) as Model<Api>[],
);
const registry = {
	isKeylessProvider: () => false,
	hasConfiguredAuth: () => true,
	authStorage: { hasAuth: () => true },
} as unknown as ModelRegistry;

function projectFresh() {
	const rows = buildAuthAwareBrowserItems(models, registry);
	sortModelItems(rows, {});
	return rows;
}

// Seed the static projection exactly as opening the first settings picker does.
cachedAuthAwareBrowserItems(models, registry);

const baselineStart = performance.now();
let baseline = projectFresh();
for (let i = 1; i < ITERATIONS; i += 1) baseline = projectFresh();
const baselineMs = performance.now() - baselineStart;

const cachedStart = performance.now();
let cached = cachedAuthAwareBrowserItems(models, registry);
for (let i = 1; i < ITERATIONS; i += 1) cached = cachedAuthAwareBrowserItems(models, registry);
const cachedMs = performance.now() - cachedStart;

const projection = (rows: typeof baseline) =>
	rows.map(row => ({ selector: row.selector, label: row.label, badge: row.badge, badgeColor: row.badgeColor }));
if (!Bun.deepEquals(projection(baseline), projection(cached))) {
	throw new Error("Cached model selector projection changed row ordering or badges");
}

process.stdout.write(
	`${JSON.stringify(
		{
			models: models.length,
			iterations: ITERATIONS,
			baselineMs: Number(baselineMs.toFixed(3)),
			cachedMs: Number(cachedMs.toFixed(3)),
			speedup: Number((baselineMs / cachedMs).toFixed(2)),
			parity: true,
		},
		null,
		2,
	)}\n`,
);
