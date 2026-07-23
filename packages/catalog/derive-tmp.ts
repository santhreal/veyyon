import MODELS from "./src/models.json" with { type: "json" };
import type { Api, ModelSpec } from "./src/types";
import { collapseEffortVariantsAcrossProviders } from "./src/variant-collapse";

const all = MODELS as Record<string, Record<string, unknown>>;
for (const prov of Object.keys(all)) {
	const slice = Object.values(all[prov] ?? {}) as ModelSpec<Api>[];
	const out = collapseEffortVariantsAcrossProviders(slice);
	if (out.length !== slice.length) {
		const outIds = new Set(out.map(s => s.id));
		const gone = slice.filter(s => !outIds.has(s.id)).map(s => s.id);
		console.log(prov, `${slice.length}->${out.length}`, "absorbed:", gone.join(", "));
	}
}
