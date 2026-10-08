/**
 * Builds `STORES` isolated settings stores per arm, keeps them referenced, and prints, as JSON, the
 * heap and extra memory each store leaves live in three arms: `idle`, a store nobody reads;
 * `snapshot`, a store that recorded its effective settings once through `getEffectiveSnapshot`; and
 * `everyPath`, a store that read every declared path through `get`, which memoizes each one.
 *
 * Every arm runs once before it is measured, so no arm pays for code the others compiled first.
 */
import { heapStats } from "bun:jsc";
import { Settings } from "@veyyon/coding-agent/config/settings";

export const STORES = 200;

export interface SnapshotRetention {
	/** Declared setting paths the snapshot resolved. */
	paths: number;
	/** Bytes per store each arm left live. */
	idle: number;
	snapshot: number;
	everyPath: number;
}

type Arm = (store: Settings) => void;

function live(): number {
	Bun.gc(true);
	const stats = heapStats();
	return stats.heapSize + stats.extraMemorySize;
}

let paths: string[] = [];
const arms: Record<"idle" | "snapshot" | "everyPath", Arm> = {
	idle: () => {},
	snapshot: store => {
		paths = Object.keys(store.getEffectiveSnapshot());
	},
	everyPath: store => {
		for (const key of paths) store.get(key as never);
	},
};

function perStore(arm: Arm): number {
	const stores: Settings[] = [];
	const before = live();
	for (let i = 0; i < STORES; i++) {
		const store = Settings.isolated();
		arm(store);
		stores.push(store);
	}
	const after = live();
	if (stores.length !== STORES) throw new Error("a store was dropped before it was measured");
	return (after - before) / STORES;
}

for (const arm of Object.values(arms)) arm(Settings.isolated());

const result: SnapshotRetention = {
	paths: paths.length,
	idle: perStore(arms.idle),
	snapshot: perStore(arms.snapshot),
	everyPath: perStore(arms.everyPath),
};
process.stdout.write(JSON.stringify(result));
