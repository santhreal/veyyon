/**
 * Loads the models config at argv[2] through `ModelsConfigFile`, in a fresh process, and prints, as
 * JSON, the load's status and value, whether the process evaluated ArkType, the ArkType nodes the load
 * registered, and the heap and extra memory it left live.
 *
 * ArkType registers every schema node it builds in the process-global `$ark` registry for the life
 * of the process, so a load that builds the models-config validator registers hundreds of nodes and
 * a load served from the accepted-value snapshot registers none.
 */
import { heapStats } from "bun:jsc";
import { ModelsConfigFile } from "@veyyon/coding-agent/config/models-config";

export interface ModelsConfigLoad {
	status: string;
	value: unknown;
	/** Whether the process-global `$ark` registry exists; evaluating `arktype` or `arktype/config` installs it. */
	arktypeEvaluated: boolean;
	/** ArkType nodes the load added to the process-global registry. */
	registeredNodes: number;
	/** Heap and extra memory the load left live, in bytes. */
	retained: number;
}

function registeredNodeCount(): number {
	const registry = (globalThis as { $ark?: { nodesByRegisteredId?: object } }).$ark;
	return registry?.nodesByRegisteredId ? Object.keys(registry.nodesByRegisteredId).length : 0;
}

function live(): number {
	Bun.gc(true);
	const stats = heapStats();
	return stats.heapSize + stats.extraMemorySize;
}

const file = ModelsConfigFile.relocate(process.argv[2]);
const nodesBefore = registeredNodeCount();
const before = live();
const result = file.tryLoad();
const retained = live() - before;

const load: ModelsConfigLoad = {
	status: result.status,
	value: result.status === "ok" ? result.value : undefined,
	arktypeEvaluated: "$ark" in globalThis,
	registeredNodes: registeredNodeCount() - nodesBefore,
	retained,
};
process.stdout.write(JSON.stringify(load));
