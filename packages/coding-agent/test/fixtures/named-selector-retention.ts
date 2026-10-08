/**
 * Builds a model registry over the scratch directory argv[2], resolves the CLI selector argv[3] to
 * warm the resolver, resolves the CLI selector argv[4], then lists the whole catalog, and prints,
 * as JSON, the heap and extra memory the second resolution and the listing each left live.
 *
 * The warm-up selector names another provider than the measured one, so the measured resolution
 * pays for its own provider and for nothing the first call compiled or cached.
 */
import { heapStats } from "bun:jsc";
import * as path from "node:path";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resolveCliModel } from "@veyyon/coding-agent/config/model-resolver";

export interface SelectorRetention {
	/** `provider/id` of the model the measured selector resolved to. */
	resolved: string | undefined;
	/** Bytes the measured resolution left live. */
	named: number;
	/** Bytes listing the whole catalog left live after that. */
	listed: number;
}

function live(): number {
	Bun.gc(true);
	const stats = heapStats();
	return stats.heapSize + stats.extraMemorySize;
}

const [dir, warmSelector, selector] = process.argv.slice(2);
const authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
const registry = new ModelRegistry(authStorage, path.join(dir, "models.yml"), { snapshotIo: false });

const warm = resolveCliModel({ cliModel: warmSelector, modelRegistry: registry });
if (!warm.model) throw new Error(`warm-up selector ${warmSelector} resolved nothing: ${warm.error}`);

const beforeNamed = live();
const measured = resolveCliModel({ cliModel: selector, modelRegistry: registry });
const afterNamed = live();
const catalog = registry.getAll();
const afterListed = live();

const result: SelectorRetention = {
	resolved: measured.model && `${measured.model.provider}/${measured.model.id}`,
	named: afterNamed - beforeNamed,
	listed: afterListed - afterNamed,
};
process.stdout.write(JSON.stringify(result));
authStorage.close();
// The catalog stays referenced until the listing is measured.
if (catalog.length === 0) throw new Error("the catalog listed no model");
