/**
 * WHY: `sanitizeSchemaForStrictMode` memoizes each node it visits so a shared subgraph is
 * sanitized once and a cycle terminates. A `nullable: true` node was cached as its inner,
 * non-null form while the first reference received the `anyOf: [T, null]` wrapper, so a
 * node referenced twice lost its null branch at the second reference: the strict schema
 * depended on whether the caller reused one object or wrote two equal ones.
 *
 * The class this suite closes: any rewrite whose result differs from the node the cache
 * holds. Every rewrite form the sanitizer applies is placed twice under every container
 * it recurses into, and the result must equal sanitizing the same schema with the two
 * references written out as separate objects. Forms and containers come from
 * `helpers/strict-schema-forms`, which reads the combinator containers from `COMBINATOR_KEYS`.
 *
 * Not caught: a rewrite form missing from `STRICT_REWRITE_FORMS`. The forms mirror the
 * branches of the sanitizer, which are code paths rather than an enumerable table.
 */
import { describe, expect, it } from "bun:test";
import { sanitizeSchemaForStrictMode } from "@veyyon/ai/utils/schema";
import { type Schema, STRICT_CONTAINERS, STRICT_REWRITE_FORMS, withStrictRefDefs } from "./helpers/strict-schema-forms";

describe("a strict-mode schema node sanitizes the same at every reference", () => {
	for (const [formName, form] of Object.entries(STRICT_REWRITE_FORMS)) {
		for (const [containerName, container] of Object.entries(STRICT_CONTAINERS)) {
			it(`${formName} placed twice under ${containerName}`, () => {
				const shared = withStrictRefDefs(container(form()));
				const separate = withStrictRefDefs(JSON.parse(JSON.stringify(shared)) as Schema);
				expect(sanitizeSchemaForStrictMode(shared)).toEqual(sanitizeSchemaForStrictMode(separate));
			});
		}
	}

	it("a nullable node that references itself resolves to its nullable form", () => {
		const node: Schema = { type: "object", properties: {} as Schema, nullable: true, description: "a tree" };
		(node.properties as Schema).child = node;
		const sanitized = sanitizeSchemaForStrictMode(node);
		expect(sanitized.description).toBe("a tree");
		const [inner, nullBranch] = sanitized.anyOf as [Schema, Schema];
		expect(nullBranch).toEqual({ type: "null" });
		expect(inner.description).toBeUndefined();
		expect((inner.properties as Schema).child).toBe(sanitized);
	});
});
