/**
 * Builds discriminable ArkType unions in whichever validation mode the process runs, then reports how
 * many of the union nodes the build registered hold a discriminant once the build returns, what each
 * union does with a valid and an invalid value, and what a union a jitless scope holds does when a
 * compiling scope references it.
 *
 * Imported by the test process, which compiles ArkType validators, and by
 * `arktype-union-discriminants-jitless.ts`, which runs it in a process configured jitless as the CLI
 * entry configures it.
 */
import { scope, type } from "arktype";
import { registeredNodes } from "./arktype-lazy-members";

/** The members `patches/@ark%2Fschema@0.56.2.patch` builds on first read. */
export const DISCRIMINANT_MEMBERS = ["discriminant", "discriminantJson"] as const;

export interface UnionDiscriminantReport {
	/** Union nodes the build registered. */
	unions: number;
	/** For each discriminant member, how many of those unions hold it as an own property. */
	ownAfterBuild: Record<string, number>;
	/** Each union applied to its values, in order: the output, or the error summary. */
	outcomes: string[];
	/** The discriminant of the tagged union, as JSON, read after the build. */
	taggedDiscriminant: unknown;
	/** The discriminant members the tagged union holds as own properties after that read. */
	ownAfterRead: string[];
}

function outcome(result: unknown): string {
	return result instanceof type.errors ? `rejects: ${result.summary}` : `accepts: ${JSON.stringify(result)}`;
}

/**
 * Builds the unions, applies each to its values, and counts the discriminants the registered unions
 * hold. Every key and literal carries `salt`, so no node comes from the cache of an earlier build in
 * the process and the outcomes read the same for any salt once it is replaced by `<salt>`.
 */
export function reportUnionDiscriminants(salt: string): UnionDiscriminantReport {
	const before = registeredNodes();
	const tagged = type
		.raw({ kind: `'a_${salt}'`, x: "number" })
		.or({ kind: `'b_${salt}'`, y: "string" })
		.or({ kind: `'c_${salt}'`, z: "boolean" });
	const literals = type.raw(`'x_${salt}' | 'y_${salt}' | 3`);
	const domains = type.raw({ [`v_${salt}`]: "string | number[] | boolean" });
	// A union a jitless scope holds under a key, reached by a compiling scope through the object that
	// holds it: the compiling scope rebuilds the object it references, and compiles the union under it
	// as the jitless scope built it.
	const jitless = scope({}, { jitless: true }).type.raw({
		[`wrap_${salt}`]: type.raw({ kind: `'p_${salt}'`, n: "number" }).or({ kind: `'q_${salt}'`, s: "string" }),
	});
	const outer = type.raw({ inner: jitless, count: "number" });

	const outcomes = [
		outcome(tagged({ kind: `a_${salt}`, x: 1 })),
		outcome(tagged({ kind: `b_${salt}`, y: 2 })),
		outcome(tagged({ kind: `d_${salt}` })),
		outcome(literals(`x_${salt}`)),
		outcome(literals(4)),
		outcome(domains({ [`v_${salt}`]: [1, 2] })),
		outcome(domains({ [`v_${salt}`]: null })),
		outcome(outer({ inner: { [`wrap_${salt}`]: { kind: `q_${salt}`, s: "ok" } }, count: 1 })),
		outcome(outer({ inner: { [`wrap_${salt}`]: { kind: `p_${salt}`, n: "no" } }, count: 1 })),
		outcome(outer({ inner: { [`wrap_${salt}`]: { kind: `r_${salt}` } }, count: 1 })),
	].map(text => text.replaceAll(salt, "<salt>"));

	const ownAfterBuild: Record<string, number> = Object.fromEntries(DISCRIMINANT_MEMBERS.map(member => [member, 0]));
	let unions = 0;
	for (const node of registeredNodes()) {
		if (node.kind !== "union" || before.has(node)) continue;
		unions++;
		for (const member of DISCRIMINANT_MEMBERS) if (Object.hasOwn(node, member)) ownAfterBuild[member]!++;
	}

	const internal: unknown = Reflect.get(tagged, "internal");
	const discriminantJson: unknown =
		typeof internal === "function" ? Reflect.get(internal, "discriminantJson") : undefined;
	const ownAfterRead =
		typeof internal === "function" ? DISCRIMINANT_MEMBERS.filter(member => Object.hasOwn(internal, member)) : [];

	return {
		unions,
		ownAfterBuild,
		outcomes,
		taggedDiscriminant: JSON.parse(JSON.stringify(discriminantJson ?? null).replaceAll(salt, "<salt>")),
		ownAfterRead,
	};
}
