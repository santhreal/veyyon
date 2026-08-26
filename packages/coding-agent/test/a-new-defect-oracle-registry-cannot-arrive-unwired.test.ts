/**
 * A new defect oracle registry cannot arrive unwired.
 *
 * WHY THIS SUITE EXISTS:
 * Four registries exist, and each arrival repeated the same wiring: declare the guarantee ids, hold a
 * `Record` from id to check, appear in the corpus family axis, map to a guarantee list, register a
 * state validator and a replay, and carry at least one committed reproduction. Nothing forced those to
 * agree. A registry missing from one of them still compiles, still runs, and still reports verdicts;
 * what it does not do is record a reproduction of anything it finds, which is exactly the state the
 * corpus was built to end. The failure mode is silent by construction, so it needs a test whose
 * subject is the set of registries rather than any one of them.
 *
 * Two of the six are compile errors now: `CorpusFamily` is the key of `DEFECT_ORACLE_REGISTRIES`, and
 * `ORACLE_FAMILIES` is a `Record` over that union, so a registry with no state reader and no replay
 * does not build. This suite covers what the type system cannot see.
 *
 * WHAT IT ASSERTS:
 * The registry set is derived at run time from `DEFECT_ORACLE_REGISTRIES`, never listed here, so a
 * fifth registry is swept the moment it is named. For each one: the declared guarantee ids are exactly
 * the keys of its `Record`, in both directions, so an entry with no id and an id with no entry are
 * both caught; the ids are unique inside the registry; and the corpus maps the family to that same
 * guarantee list, so a case cannot name an oracle its family's registry does not declare.
 *
 * Across the registries: no guarantee id is used by two of them. A corpus case carries a family and an
 * oracle, and the loader checks the oracle against that family's registry; two registries sharing an
 * id would let a case whose family was recorded wrong validate against the wrong registry and replay
 * as a scenario nobody recorded.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * - Whether a registry's checks are correct, or can fail at all. That is each registry's own
 *   crafted-defect suite.
 * - Whether a family has a committed reproduction. That is asserted by the replay suite, which is the
 *   one that reads the corpus directory.
 * - A registry that exists as a module and is never named in the table. Nothing can see that but a
 *   reader; the table is the definition of what a registry is here.
 *
 * MUTATION GATE, run and recorded:
 * 1. Adding a fifth entry to `DEFECT_ORACLE_REGISTRIES` that reuses one of the composer guarantee ids
 *    turns two of these red, the uniqueness claim and the family claim, and produces two type errors
 *    in the corpus, which has no reader and no replay for the new family.
 * 2. Removing one id from a registry's declared tuple while leaving its `Record` entry in place turns
 *    that registry's partition claim red.
 */

import { describe, expect, it } from "bun:test";
import { DEFECT_ORACLE_REGISTRIES, DEFECT_ORACLE_REGISTRY_NAMES } from "../src/modes/components/defect-oracles";
import { CORPUS_FAMILIES, CORPUS_FAMILY_GUARANTEES } from "./helpers/renderer-defect-corpus";

const NAMES = DEFECT_ORACLE_REGISTRY_NAMES.map(name => [name] as const);

describe("every registry declares exactly what it holds", () => {
	it.each(NAMES)("%s: the declared ids are the entries it has", name => {
		const registry = DEFECT_ORACLE_REGISTRIES[name];
		expect([...registry.entryIds].sort()).toEqual([...registry.guarantees].sort());
	});

	it.each(NAMES)("%s: declares no id twice", name => {
		const registry = DEFECT_ORACLE_REGISTRIES[name];
		expect(new Set(registry.guarantees).size).toBe(registry.guarantees.length);
	});

	it.each(NAMES)("%s: judges something it can name", name => {
		expect(DEFECT_ORACLE_REGISTRIES[name].subject.length).toBeGreaterThan(0);
		expect(DEFECT_ORACLE_REGISTRIES[name].guarantees.length).toBeGreaterThan(0);
	});
});

describe("the corpus knows every registry", () => {
	it("has one family per registry and no other", () => {
		expect([...CORPUS_FAMILIES].sort()).toEqual([...DEFECT_ORACLE_REGISTRY_NAMES].sort());
	});

	it.each(NAMES)("%s: the family maps to that registry's own guarantees", name => {
		expect([...CORPUS_FAMILY_GUARANTEES[name]]).toEqual([...DEFECT_ORACLE_REGISTRIES[name].guarantees]);
	});
});

describe("a guarantee id belongs to one registry", () => {
	it("is used by no second registry", () => {
		const owners = new Map<string, string[]>();
		for (const name of DEFECT_ORACLE_REGISTRY_NAMES) {
			for (const guarantee of DEFECT_ORACLE_REGISTRIES[name].guarantees) {
				owners.set(guarantee, [...(owners.get(guarantee) ?? []), name]);
			}
		}
		const shared = [...owners.entries()]
			.filter(([, names]) => names.length > 1)
			.map(([guarantee, names]) => `${guarantee}: ${names.join(", ")}`);
		expect(shared).toEqual([]);
	});

	it("covers every guarantee the registries declare between them", () => {
		const total = DEFECT_ORACLE_REGISTRY_NAMES.reduce(
			(sum, name) => sum + DEFECT_ORACLE_REGISTRIES[name].guarantees.length,
			0,
		);
		const distinct = new Set(
			DEFECT_ORACLE_REGISTRY_NAMES.flatMap(name => [...DEFECT_ORACLE_REGISTRIES[name].guarantees]),
		);
		expect(distinct.size).toBe(total);
	});
});
