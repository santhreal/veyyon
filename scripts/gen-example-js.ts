#!/usr/bin/env bun
// The `.js` twins of the TypeScript examples are GENERATED. This script writes
// them (`--write`) or fails when they have drifted (no argument, the CI gate).
//
// Why this exists: every example under `packages/coding-agent/examples` ships
// twice, `hello.ts` beside `hello.js`, so a reader working in plain JavaScript
// can copy one without stripping types by hand. Both copies were maintained by
// hand, nothing compared them, and they drifted:
//
//   - `hooks/git-checkpoint.js` still carried the docblock and comments from
//     before its TypeScript twin was rewritten, so the JavaScript reader was
//     handed the older explanation of a hook that touches `git stash`.
//   - `hooks/custom-compaction.js` and `hooks/handoff.js` had their imports in a
//     different order than the twin they were transpiled from.
//   - `extensions/pirate.js` and `hooks/file-trigger.js` both reproduced their
//     twin's type errors (`systemPromptAppend`, which no result type has, and a
//     bare `true` where an options object goes), because a fix applied to the
//     `.ts` copy was not applied to the `.js` copy.
//
// The TypeScript file is now the only source. The `.js` is `tsc` output, so
// comments survive the transpile and the reader still gets the explanation.
//
// One consequence worth knowing: a docblock that sits directly above a type-only
// import is dropped, because the import itself is erased. Put a file's header
// comment above a value import, or above the first statement, if it must appear
// in the generated JavaScript too.
//
// CI gate: .github/workflows/docs.yml.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The package whose examples ship a generated `.js` beside every `.ts`. */
export const EXAMPLES_PACKAGE = "packages/coding-agent";
/**
 * Projects transpiled to produce the twins, package-relative.
 *
 * `with-deps/` needs its own entry because it is a package of its own: its `ms`
 * dependency is deliberately outside the workspace (that is the point of the
 * example), so it cannot be part of the workspace examples project. Without an
 * entry here its twin would be the one example nothing could regenerate, which
 * is exactly the hand-maintained state this gate replaces.
 */
export const EXAMPLES_TSCONFIGS = ["tsconfig.examples.json", "examples/extensions/with-deps/tsconfig.json"] as const;

export interface GeneratedTwin {
	/** Repo-relative path of the generated `.js`. */
	rel: string;
	/** Freshly transpiled contents. */
	generated: string;
	/** Committed contents, or undefined when the twin does not exist yet. */
	committed: string | undefined;
}

/**
 * Transpile the examples project into a scratch directory and pair each emitted
 * `.js` with the committed twin beside its source.
 *
 * Emitting the whole project rather than file-by-file is deliberate: the output
 * then follows the project's own `target`/`module` settings, which is what makes
 * the generated file identical to what the repository already had for the
 * twenty-plus examples that never drifted.
 */
export function generateTwins(repoRoot: string): GeneratedTwin[] {
	const packageDir = path.join(repoRoot, EXAMPLES_PACKAGE);
	const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-example-js-"));
	try {
		for (const project of EXAMPLES_TSCONFIGS) {
			const emit = spawnSync(
				"bunx",
				[
					"tsgo",
					"-p",
					project,
					"--noEmit",
					"false",
					"--outDir",
					outDir,
					// Pinned so both projects lay their output out the same way: every
					// emitted file lands at its path relative to the package, whatever
					// the project's own include globs are.
					"--rootDir",
					packageDir,
					"--declaration",
					"false",
					"--sourceMap",
					"false",
				],
				{ cwd: packageDir, encoding: "utf8" },
			);
			// A type error in an example is a finding for the typecheck gate, not for
			// this one, and tsc still emits. Only a missing emit is fatal here.
			if (!fs.existsSync(path.join(outDir, "examples"))) {
				throw new Error(`transpiling ${EXAMPLES_PACKAGE}/${project} emitted nothing:\n${emit.stderr}`);
			}
		}
		const emittedRoot = path.join(outDir, "examples");

		const twins: GeneratedTwin[] = [];
		const stack = [emittedRoot];
		while (stack.length > 0) {
			const dir = stack.pop() as string;
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					stack.push(full);
					continue;
				}
				if (!entry.name.endsWith(".js")) continue;
				const relInPackage = path.relative(outDir, full);
				const target = path.join(packageDir, relInPackage);
				// Only examples that ALREADY ship a `.js` twin are generated. A `.ts`
				// example without one is a deliberate choice (`with-deps/` is a package
				// of its own), not something to start emitting into the tree.
				if (!fs.existsSync(target)) continue;
				twins.push({
					rel: path.join(EXAMPLES_PACKAGE, relInPackage).replaceAll(path.sep, "/"),
					generated: fs.readFileSync(full, "utf8"),
					committed: fs.readFileSync(target, "utf8"),
				});
			}
		}
		return twins.sort((a, b) => a.rel.localeCompare(b.rel));
	} finally {
		fs.rmSync(outDir, { recursive: true, force: true });
	}
}

/** Twins whose committed contents differ from a fresh transpile. */
export function driftedTwins(twins: readonly GeneratedTwin[]): GeneratedTwin[] {
	return twins.filter(twin => twin.committed !== twin.generated);
}

if (import.meta.main) {
	const repoRoot = path.resolve(import.meta.dirname, "..");
	const twins = generateTwins(repoRoot);
	const drifted = driftedTwins(twins);

	if (process.argv.includes("--write")) {
		for (const twin of drifted) {
			fs.writeFileSync(path.join(repoRoot, twin.rel), twin.generated);
			console.log(`wrote ${twin.rel}`);
		}
		console.log(`${twins.length} example twin(s) checked, ${drifted.length} rewritten`);
	} else if (drifted.length > 0) {
		for (const twin of drifted) console.error(`stale: ${twin.rel}`);
		console.error(
			`\n${drifted.length} generated example twin(s) differ from their TypeScript source. ` +
				`Run: bun scripts/gen-example-js.ts --write`,
		);
		process.exit(1);
	} else {
		console.log(`${twins.length} example twin(s) are up to date`);
	}
}
