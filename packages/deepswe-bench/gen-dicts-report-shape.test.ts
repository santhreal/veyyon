/**
 * The task-selection report describes the dictionary the generator actually
 * produces.
 *
 * WHY THIS SUITE EXISTS. `gen-dicts.ts` is the instrument that decides which
 * DeepSWE tasks are worth spending hours of benchmark time on, and it ranked and
 * reported on ONE column: `typeable saving`, the saving available from handles
 * whose expansion contains no whitespace. That column was sound when it was
 * written, and its header said so in the strongest terms: whitespace-bearing
 * handles were prose (license blocks, fixture YAML, doc URLs), prose is never
 * retyped, so a near-zero typeable saving meant "this task cannot demonstrate
 * codec value at all, whatever the model does".
 *
 * The generator has since learned to mint LINE STRUCTURE, which is
 * whitespace-bearing and is retyped constantly, and it now dominates. That turned
 * a sound one-sided screen into a misleading one without changing a line of
 * `gen-dicts.ts`: it reports `handles=43, typeable=0` for a repo whose dictionary
 * is 43 rows of exactly the class the generator was changed to find, and a reader
 * following the header's own instruction excludes the task.
 *
 * This is the shape of failure a coherence test exists for. Neither half is
 * broken on its own. The generator does what it now intends, the report computes
 * its column correctly, and nothing throws. What broke is the AGREEMENT between
 * them, and the only symptom is a benchmark spent on the wrong tasks.
 *
 * The assertions run the real `generateDictFromRepo` over an in-memory corpus, so
 * they need no checkout and no network, and they fail if the generator's output
 * ever drifts away from what the report is built to describe.
 */
import { describe, expect, it } from "bun:test";
import { generateDictFromRepo } from "argot";
import { typeableHandleMass } from "./aggregate";

/** Ordinary tab-indented source, which is what every task repo is made of. */
function sourceFiles(count: number): { path: string; content: string }[] {
	return Array.from({ length: count }, (_, i) => ({
		path: `pkg/mod${i}.ts`,
		content: [
			`import { helper } from "./shared/helper";`,
			`export class Widget${i} {`,
			`\t\tconst a = helper(1);`,
			`\t\tconst b = helper(2);`,
			`\t\tif (a) {`,
			`\t\t\t\treturn a;`,
			`\t\t}`,
			`\t\treturn b;`,
			`}`,
		].join("\n"),
	}));
}

/** The two columns the report shows side by side, computed the way it computes them. */
function reportColumns(files: { path: string; content: string }[]) {
	const { handles } = generateDictFromRepo(files, {});
	const entries: Record<string, string> = {};
	for (const handle of handles) entries[handle.name] = handle.expansion;
	return {
		handles: handles.length,
		structureHandles: handles.filter(handle => handle.expansion.startsWith("\n")).length,
		typeableHandles: typeableHandleMass(entries).typeable,
	};
}

describe("gen-dicts report columns against a real generated dictionary", () => {
	it("reports a non-empty dictionary for a code repo, which one column alone could not", () => {
		// THE REGRESSION, stated as the reader experiences it. Before the structure
		// column existed, this repo's row read `handles=N, typeable=0`, and the
		// header told the reader that meant the task was unmeasurable. Both numbers
		// were correct; together they said something false.
		const columns = reportColumns(sourceFiles(8));

		expect(columns.handles).toBeGreaterThan(0);
		expect(columns.structureHandles).toBeGreaterThan(0);
	});

	it("structure is the majority of what the generator produces on source", () => {
		// The magnitude, which is what makes the missing column a defect rather
		// than an omission. If structure were a small tail, ranking on the
		// non-structure part would still be approximately right.
		const columns = reportColumns(sourceFiles(8));

		expect(columns.structureHandles / columns.handles).toBeGreaterThan(0.5);
	});

	it("the two columns are disjoint, so neither is a subset of the other", () => {
		// `typeableHandles` excludes whitespace by construction and structure is
		// whitespace-bearing, so a reader can add them without double counting.
		// Asserted because a future change to either predicate that made them
		// overlap would silently turn the report's two columns into a lie about
		// the same handles counted twice.
		const columns = reportColumns(sourceFiles(8));

		expect(columns.structureHandles + columns.typeableHandles).toBeLessThanOrEqual(columns.handles);
	});

	it("a prose-only corpus still reports no structure, so the column means something", () => {
		// NON-VACUITY. Every assertion above would be satisfied by a column that
		// simply counted all handles. A corpus with no repeated indentation must
		// produce no structure handles, or the column is not measuring structure.
		const prose = Array.from({ length: 6 }, (_, i) => ({
			path: `docs/page${i}.md`,
			content: "See https://example.com/reference/guide for details about the configuration file.\n",
		}));
		const columns = reportColumns(prose);

		expect(columns.structureHandles).toBe(0);
	});
});
