/**
 * Prints as JSON, for an in-memory session seeded with a relative cwd, the values each group of cwd
 * reads returned and how many distinct string cells each group holds, read from a heap snapshot.
 *
 * Groups: `getCwd` after the seed; `setCwd(".")` and `getCwd` after it; `setCwd` to a directory
 * relative to the session cwd, the `next` value its cwd listener received, the header cwd and `getCwd`;
 * `getCwd` after `restoreState` of a captured state whose cwd is relative.
 *
 * Run as its own process: a heap snapshot costs in proportion to the heap of the process taking it.
 */
import * as path from "node:path";
import { SessionManager } from "@veyyon/kernel/session/session-manager";

export const READ_GROUPS = ["seed", "sameDirectory", "moved", "restored"] as const;
export type ReadGroup = (typeof READ_GROUPS)[number];

export interface SessionCwdReport {
	/** The relative seed, from the process cwd, and the directory the session moves to, from the seed. */
	seed: string;
	other: string;
	/** Every value each group of reads returned. */
	values: Record<ReadGroup, string[]>;
	/** Distinct string cells each group of reads holds. */
	cells: Record<ReadGroup, number>;
	/** Distinct string cells the seed and same-directory groups hold together. */
	seedAndSameDirectoryCells: number;
}

const MARKER = "sessionCwdReadGroup_";

/** Distinct snapshot ids of the elements of every array the snapshot reaches through a marker property. */
function cellsByGroup(groups: Record<string, string[]>): Map<string, Set<number>> {
	const snapshot = Bun.generateHeapSnapshot();
	// groups stays reachable until the snapshot is taken.
	void groups;
	const { edges, edgeNames, edgeTypes } = snapshot;
	const property = edgeTypes.indexOf("Property");
	const index = edgeTypes.indexOf("Index");
	const arrays = new Map<number, string>();
	for (let at = 0; at < edges.length; at += 4) {
		const name = edgeNames[edges[at + 3]!]!;
		if (edges[at + 2] === property && name.startsWith(MARKER)) arrays.set(edges[at + 1]!, name.slice(MARKER.length));
	}
	const cells = new Map<string, Set<number>>();
	for (let at = 0; at < edges.length; at += 4) {
		const group = arrays.get(edges[at]!);
		if (group === undefined || edges[at + 2] !== index) continue;
		const set = cells.get(group) ?? new Set<number>();
		set.add(edges[at + 1]!);
		cells.set(group, set);
	}
	return cells;
}

// Built at run time so none of the values is a string literal the module holds.
const seed = path.join("session-cwd-reads", `seed-${process.pid}`);
const other = path.join("session-cwd-reads", `other-${process.pid}`);
const manager = SessionManager.inMemory(seed);
const values: Record<ReadGroup, string[]> = { seed: [], sameDirectory: [], moved: [], restored: [] };

values.seed.push(manager.getCwd(), manager.getCwd(), manager.getCwd());

values.sameDirectory.push(await manager.setCwd(".", { validate: false }), manager.getCwd());

const heard: string[] = [];
const unsubscribe = manager.onCwdChanged((_previous, next) => heard.push(next));
values.moved.push(await manager.setCwd(other, { validate: false }), ...heard, manager.getCwd());
const header = manager.getHeader();
if (header) values.moved.push(header.cwd);
unsubscribe();

manager.restoreState({ ...manager.captureState(), cwd: seed });
values.restored.push(manager.getCwd(), manager.getCwd());

const cells = cellsByGroup(Object.fromEntries(READ_GROUPS.map(group => [`${MARKER}${group}`, values[group]])));
const count = (group: ReadGroup) => cells.get(group)?.size ?? 0;
const report: SessionCwdReport = {
	seed,
	other,
	values,
	cells: {
		seed: count("seed"),
		sameDirectory: count("sameDirectory"),
		moved: count("moved"),
		restored: count("restored"),
	},
	seedAndSameDirectoryCells: new Set([...(cells.get("seed") ?? []), ...(cells.get("sameDirectory") ?? [])]).size,
};
process.stdout.write(JSON.stringify(report));
