/**
 * Builds ArkType schemas and reports, for the nodes a build added, which closures each node holds
 * before anything reads it, then reads each member the patch in `patches/@ark%2Fschema@0.56.2.patch`
 * creates on first read (`allows`, `assert`, `pipe`, `rootApply`) and reports what it did.
 *
 * Imported by the test process, which compiles ArkType validators, and by
 * `arktype-node-closures.ts`, which runs it in a process configured jitless as the CLI entry
 * configures it.
 */
import { heapStats } from "bun:jsc";
import { type } from "arktype";

/** The members the patch creates on first read instead of at node construction. */
export const LAZY_MEMBERS = ["allows", "assert", "pipe", "rootApply"] as const;

export interface LazyMemberBehaviour {
	/** A detached `assert` called on a valid value. */
	detachedAssertReturns: unknown;
	/** The message a detached `assert` throws on an invalid value. */
	detachedAssertThrows: string;
	/** Two reads of `assert` return one function. */
	assertIsCached: boolean;
	/** An object schema (`allows` strategy) applied to a valid value, then whether it rejects an invalid one. */
	objectApply: unknown[];
	/** A piped string (`optimistic` strategy) applied to a valid value, then whether it rejects an invalid one. */
	pipeResult: unknown[];
	/** `pipe.try` applied to a value its morph parses. */
	pipeTryResult: unknown;
	/** `pipe.try` turns a throwing morph into a validation failure. */
	pipeTryRejects: boolean;
	/** Two reads of `pipe` return one function. */
	pipeIsCached: boolean;
	/**
	 * A union of two piped branches (`branchedOptimistic` strategy) applied to a value of each branch,
	 * then whether it rejects a value of neither.
	 */
	unionMorphs: unknown[];
	/** `allows` on a plain object schema, for a valid and an invalid value. */
	allows: boolean[];
	/** An assignment over `allows` after it was read takes effect, as a compiling scope makes one. */
	allowsReassignable: boolean;
	/** `allows` on a schema whose predicate reads the traversal context, for a valid and an invalid value. */
	contextualAllows: boolean[];
	/** That schema (`contextual` strategy) applied to a valid value, then whether it rejects an invalid one. */
	contextualApply: unknown[];
	/** The lazy members the schemas above hold as own properties after the reads. */
	ownAfterRead: string[];
	/** The `rootApply` strategy ArkType selected for the object, piped, union and contextual schemas. */
	strategies: string[];
}

export interface NodeClosureCensus {
	/** Nodes the build added to the ArkType registry. */
	nodes: number;
	/** Function cells the build retained, per node it added. */
	functionsPerNode: number;
	/**
	 * Every own property of an added node whose value is a function, is not an ArkType node and is not
	 * one of the node's own schema values: the closures ArkType allocated for the node. Sorted.
	 */
	closureKeys: string[];
	/** For each lazy member, how many added nodes hold it as an own property once the build returns. */
	lazyMembersOwnAfterBuild: Record<string, number>;
}

export interface ArkNode {
	readonly kind: string;
	readonly id: string;
	readonly inner: Readonly<Record<string, unknown>>;
}

function isArkNode(value: unknown): value is ArkNode {
	return (
		typeof value === "function" &&
		typeof Reflect.get(value, "kind") === "string" &&
		typeof Reflect.get(value, "id") === "string" &&
		typeof Reflect.get(value, "inner") === "object"
	);
}

export function registeredNodes(): Set<ArkNode> {
	const holder: unknown = Reflect.get(globalThis, "$ark");
	const registry: unknown =
		typeof holder === "object" && holder !== null ? Reflect.get(holder, "nodesByRegisteredId") : undefined;
	const nodes = new Set<ArkNode>();
	if (typeof registry !== "object" || registry === null) return nodes;
	for (const value of Object.values(registry)) if (isArkNode(value)) nodes.add(value);
	return nodes;
}

function functionCells(): number {
	Bun.gc(true);
	return heapStats().objectTypeCounts.Function ?? 0;
}

/**
 * A schema that reaches every node kind a tool parameter schema builds: required and optional keys,
 * unions of literals, bounded strings and numbers, a divisor, a pattern, arrays, a nested object, a
 * date, a predicate and a morph. Every key and literal carries `salt` so no node comes from the
 * cache of an earlier build.
 */
export function buildBroadSchema(salt: string): unknown {
	const props: Record<string, unknown> = {};
	for (let i = 0; i < 40; i++) props[`option_${salt}_${i}?`] = `'a_${salt}_${i}' | 'b_${salt}_${i}' | ${i}`;
	props[`name_${salt}`] = "string > 2";
	props[`count_${salt}?`] = "number % 3";
	props[`limit_${salt}?`] = "0 < number <= 100";
	props[`pattern_${salt}?`] = `/^${salt}-[a-z]+$/`;
	props[`paths_${salt}?`] = "string[]";
	props[`nested_${salt}?`] = { [`inner_${salt}`]: "boolean", [`list_${salt}?`]: "(string | number)[]" };
	props[`when_${salt}?`] = "Date";
	return type
		.raw(props)
		.narrow(value => typeof value === "object" && value !== null)
		.pipe(value => value);
}

/** Builds {@link buildBroadSchema} and counts what the nodes it added hold once the build returns. */
export function censusNodeClosures(): NodeClosureCensus {
	const before = registeredNodes();
	const cellsBefore = functionCells();
	const schema = buildBroadSchema(`s${Date.now().toString(36)}`);
	const cellsAfter = functionCells();
	const added = [...registeredNodes()].filter(node => !before.has(node));
	const closureKeys = new Set<string>();
	const lazyOwn: Record<string, number> = Object.fromEntries(LAZY_MEMBERS.map(member => [member, 0]));
	for (const node of added) {
		for (const key of Object.getOwnPropertyNames(node)) {
			const descriptor = Object.getOwnPropertyDescriptor(node, key);
			if (descriptor === undefined || !("value" in descriptor)) continue;
			if (key in lazyOwn) {
				lazyOwn[key]!++;
				continue;
			}
			const value: unknown = descriptor.value;
			if (typeof value !== "function" || isArkNode(value) || node.inner[key] === value) continue;
			closureKeys.add(key);
		}
	}
	// The schema stays reachable until the cells are counted.
	void schema;
	return {
		nodes: added.length,
		functionsPerNode: (cellsAfter - cellsBefore) / added.length,
		closureKeys: [...closureKeys].sort(),
		lazyMembersOwnAfterBuild: lazyOwn,
	};
}

function ownLazyMembers(...schemas: object[]): string[] {
	const own = new Set<string>();
	for (const schema of schemas) {
		for (const member of LAZY_MEMBERS) if (Object.hasOwn(schema, member)) own.add(member);
	}
	return [...own].sort();
}

/**
 * Reads every lazy member of schemas covering each strategy `rootApply` selects (`allows`,
 * `optimistic`, `branchedOptimistic`, `contextual`) and reports what each read did.
 */
export function exerciseLazyMembers(): LazyMemberBehaviour {
	const object = type({ id: "string", "size?": "number" });
	const assert = object.assert;
	const detachedAssertReturns = assert({ id: "x" });
	let detachedAssertThrows = "";
	try {
		assert({ id: 1 });
	} catch (error) {
		detachedAssertThrows = error instanceof Error ? error.message : String(error);
	}

	const text = type("string > 2");
	const pipe = text.pipe;
	const length = pipe(value => value.length);
	const parse = type("string").pipe.try((value): unknown => JSON.parse(value));

	const union = type("string")
		.pipe(value => value.length)
		.or(type("number").pipe(value => value * 2));

	const contextual = type("number").narrow((value, ctx) => value > 0 || ctx.mustBe("positive"));

	// A scope that compiles assigns its compiled traversal over `allows`, and a parse can read
	// `allows` on a node before its scope compiles it.
	const reassigned = type({ flag: "boolean" });
	const interpreted = reassigned.allows;
	const compiled = (data: unknown): boolean => data === true;
	const allowsReassignable =
		Reflect.set(reassigned, "allows", compiled) &&
		Reflect.get(reassigned, "allows") === compiled &&
		interpreted !== compiled;

	return {
		detachedAssertReturns,
		detachedAssertThrows,
		assertIsCached: object.assert === assert,
		objectApply: [object({ id: "y", size: 2 }), object({ id: "y", size: "2" }) instanceof type.errors],
		pipeResult: [length("abcd"), length("ab") instanceof type.errors],
		pipeTryResult: parse('{"ok":true}'),
		pipeTryRejects: parse("{") instanceof type.errors,
		pipeIsCached: text.pipe === pipe,
		unionMorphs: [union("abc"), union(4), union(true) instanceof type.errors],
		allows: [object.allows({ id: "x" }), object.allows({})],
		allowsReassignable,
		contextualAllows: [contextual.allows(3), contextual.allows(-3)],
		contextualApply: [contextual(3), contextual(-3) instanceof type.errors],
		ownAfterRead: ownLazyMembers(object, text, union, contextual),
		strategies: [object, length, union, contextual].map(schema => String(Reflect.get(schema, "rootApplyStrategy"))),
	};
}
