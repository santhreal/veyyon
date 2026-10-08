/**
 * Prints as JSON, from a process configured ArkType jitless as the CLI entry configures it, how the
 * ArkType nodes a schema build adds hold their serializations: whether `hash` and `innerHash` are one
 * string cell, read from a heap snapshot, and whether `json` and `innerJson` are one object, split by
 * whether the node carries metadata. Also prints the `json` and cache behaviour those members feed.
 *
 * Run as its own process: a heap snapshot costs in proportion to the heap of the process taking it.
 */
import "./arktype-jitless";
import { type } from "arktype";
import { type ArkNode, buildBroadSchema, registeredNodes } from "./arktype-lazy-members";

export interface NodeSerializationCensus {
	/** Nodes the build added that carry no metadata. */
	withoutMeta: number;
	/** Of those, the nodes whose `hash` and `innerHash` are two string cells. */
	withoutMetaTwoHashCells: number;
	/** Of those, the nodes whose `json` and `innerJson` are two objects. */
	withoutMetaTwoJsonValues: number;
	/** Nodes the build added that carry metadata. */
	withMeta: number;
	/** Of those, the nodes whose `hash` serializes the metadata and whose `innerHash` does not. */
	withMetaHashCarriesMeta: number;
	/** Of those, the nodes whose `json` holds the metadata and whose `innerJson` does not. */
	withMetaJsonCarriesMeta: number;
}

export interface NodeSerializationReport {
	census: NodeSerializationCensus;
	/** The key the `json` schemas declare, salted so no node comes from the cache of an earlier build. */
	key: string;
	/** `json` of an object schema, of a described string and of a described object with a described key. */
	json: unknown[];
	/**
	 * Whether a second parse of an object definition, of a described definition and of a described
	 * object definition returned the node the first parse built.
	 */
	reparseReturnsCachedNode: boolean[];
	/** Whether the described and the undescribed node of one definition are distinct nodes. */
	describedIsDistinct: boolean;
}

interface SerializedNode extends ArkNode {
	readonly meta: Readonly<Record<string, unknown>>;
	readonly hash: string;
	readonly innerHash: string;
	readonly json: unknown;
	readonly innerJson: unknown;
}

function isSerializedNode(node: ArkNode): node is SerializedNode {
	return (
		typeof Reflect.get(node, "hash") === "string" &&
		typeof Reflect.get(node, "innerHash") === "string" &&
		typeof Reflect.get(node, "meta") === "object"
	);
}

function hasOwnMeta(value: unknown): boolean {
	return typeof value === "object" && value !== null && Object.hasOwn(value, "meta");
}

const MARKER_WITHOUT_META = "arktypeSerializationCensusWithoutMeta";
const MARKER_WITH_META = "arktypeSerializationCensusWithMeta";

/**
 * For each marker array the snapshot reaches through a property named `marker`, the snapshot ids of
 * every element's `hash` and `innerHash` string cells.
 */
function hashCellsByMarker(markers: Record<string, SerializedNode[]>): Map<string, [number, number][]> {
	const snapshot = Bun.generateHeapSnapshot();
	// markers stays reachable until the snapshot is taken.
	void markers;
	const { edges, edgeNames, edgeTypes } = snapshot;
	const property = edgeTypes.indexOf("Property");
	const index = edgeTypes.indexOf("Index");
	const markerArrays = new Map<number, string>();
	for (let at = 0; at < edges.length; at += 4) {
		if (edges[at + 2] !== property) continue;
		const name = edgeNames[edges[at + 3]!]!;
		if (name === MARKER_WITHOUT_META || name === MARKER_WITH_META) markerArrays.set(edges[at + 1]!, name);
	}
	const elementMarker = new Map<number, string>();
	for (let at = 0; at < edges.length; at += 4) {
		const marker = markerArrays.get(edges[at]!);
		if (marker !== undefined && edges[at + 2] === index) elementMarker.set(edges[at + 1]!, marker);
	}
	const cells = new Map<number, [number, number]>();
	for (let at = 0; at < edges.length; at += 4) {
		const from = edges[at]!;
		if (edges[at + 2] !== property || !elementMarker.has(from)) continue;
		const name = edgeNames[edges[at + 3]!];
		if (name !== "hash" && name !== "innerHash") continue;
		const pair = cells.get(from) ?? [-1, -1];
		pair[name === "hash" ? 0 : 1] = edges[at + 1]!;
		cells.set(from, pair);
	}
	const byMarker = new Map<string, [number, number][]>();
	for (const [node, pair] of cells) {
		const marker = elementMarker.get(node)!;
		const list = byMarker.get(marker) ?? [];
		list.push(pair);
		byMarker.set(marker, list);
	}
	return byMarker;
}

function censusNodeSerializations(): NodeSerializationCensus {
	const before = registeredNodes();
	const salt = `s${Date.now().toString(36)}`;
	const broad = buildBroadSchema(salt);
	const described = type({
		[`label_${salt}`]: type("string").describe(`label ${salt}`),
		[`size_${salt}?`]: type("number >= 0").describe(`size ${salt}`),
	}).describe(`described ${salt}`);
	const added = [...registeredNodes()].filter(node => !before.has(node)).filter(isSerializedNode);
	const withoutMeta = added.filter(node => Object.keys(node.meta).length === 0);
	const withMeta = added.filter(node => Object.keys(node.meta).length > 0);
	const cells = hashCellsByMarker({ [MARKER_WITHOUT_META]: withoutMeta, [MARKER_WITH_META]: withMeta });
	const withoutMetaCells = cells.get(MARKER_WITHOUT_META) ?? [];
	if (withoutMetaCells.length !== withoutMeta.length)
		throw new Error(`the snapshot reached ${withoutMetaCells.length} of ${withoutMeta.length} nodes`);
	// The schemas stay reachable until the census is read.
	void broad;
	void described;
	return {
		withoutMeta: withoutMeta.length,
		withoutMetaTwoHashCells: withoutMetaCells.filter(([hash, innerHash]) => hash !== innerHash).length,
		withoutMetaTwoJsonValues: withoutMeta.filter(node => node.json !== node.innerJson).length,
		withMeta: withMeta.length,
		withMetaHashCarriesMeta: withMeta.filter(
			node => hasOwnMeta(JSON.parse(node.hash)) && !hasOwnMeta(JSON.parse(node.innerHash)),
		).length,
		withMetaJsonCarriesMeta: withMeta.filter(node => hasOwnMeta(node.json) && !hasOwnMeta(node.innerJson)).length,
	};
}

function reportJsonAndCache(): Omit<NodeSerializationReport, "census"> {
	const key = `k${Date.now().toString(36)}`;
	const object = (): unknown => type({ [key]: "string", [`${key}_n?`]: "number" });
	const describedString = (): unknown => type("string").describe(`text ${key}`);
	const describedObject = (): unknown =>
		type({ [key]: type("number").describe(`count ${key}`) }).describe(`outer ${key}`);
	const first = [object(), describedString(), describedObject()];
	const second = [object(), describedString(), describedObject()];
	return {
		key,
		json: first.map(node => Reflect.get(node as object, "json")),
		reparseReturnsCachedNode: first.map((node, i) => node === second[i]),
		describedIsDistinct: describedString() !== type("string"),
	};
}

const report: NodeSerializationReport = { census: censusNodeSerializations(), ...reportJsonAndCache() };
process.stdout.write(JSON.stringify(report));
