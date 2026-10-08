/**
 * WHY THIS SUITE EXISTS.
 *
 * THE DEFECT IT CLOSES. `zodToWireSchema` held `require("zod/v4/core")` in a function body. The
 * call never ran at startup, but the bundler follows a `require` like an import, so the compiled
 * binary carried a CommonJS copy of Zod in a chunk the CLI loads at startup, beside the ESM copy the
 * barrels hand out. The converter now arrives the other way round: a barrel that hands out Zod
 * imports `@veyyon/ai/utils/schema/zod-core`, which installs the converter of the Zod copy the barrel
 * loaded, and `wire.ts` holds no Zod value.
 *
 * THE CLASS. Every package root that hands Zod to an extension, a custom tool, a custom command or
 * an SDK caller must install the converter, or a `zod/mini` schema built from the Zod it handed out
 * cannot reach a provider. The barrels are found by scanning every workspace package root for a
 * value import of Zod, so a new one is swept without being named here, and the found set is pinned
 * by exact equality so a sweep that finds nothing cannot pass.
 *
 * WHAT IT DOES NOT CATCH. A Zod value handed out from a subpath rather than a package root, and an
 * extension that brings its own `zod/mini` copy and never receives the barrel. The startup side of
 * the defect, a `require` of Zod on the startup path, is caught by
 * `a-dependency-nobody-reached-does-not-load-at-startup.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { zodToWireSchema } from "@veyyon/ai/utils/schema";
import { z } from "zod/v4";
import { workspacePackages } from "./helpers/startup-import-graph";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

function isZodSpecifier(specifier: string): boolean {
	return specifier === "zod" || specifier.startsWith("zod/");
}

/** Package names whose root module imports or re-exports a Zod value. */
function barrelsHandingOutZod(): string[] {
	const barrels: string[] = [];
	for (const pkg of workspacePackages(REPO_ROOT).values()) {
		let entry: string;
		try {
			entry = Bun.resolveSync(pkg.name, REPO_ROOT);
		} catch {
			// A package with no root module hands nothing out from its root.
			continue;
		}
		if (!/\.(ts|tsx|js|mjs)$/.test(entry)) continue;
		let source = readFileSync(entry, "utf8");
		if (source.startsWith("#!")) source = source.slice(source.indexOf("\n") + 1);
		const transpiler = new Bun.Transpiler({ loader: entry.endsWith(".tsx") ? "tsx" : "ts" });
		if (transpiler.scanImports(source).some(imported => isZodSpecifier(imported.path))) barrels.push(pkg.name);
	}
	return barrels.sort();
}

const barrels = barrelsHandingOutZod();

describe("a barrel that hands out Zod", () => {
	test("is one of the barrels this suite has recorded", () => {
		expect(barrels).toEqual(["@veyyon/ai", "@veyyon/coding-agent"]);
	});

	for (const barrel of barrels) {
		test(`${barrel} converts a zod/mini schema to its classic twin's wire`, () => {
			const script = `
				import ${JSON.stringify(barrel)};
				import { zodToWireSchema } from "@veyyon/ai/utils/schema";
				import * as zm from "zod/mini";
				console.log(JSON.stringify(zodToWireSchema(zm.object({ name: zm.string(), limit: zm.optional(zm.number()) }))));
			`;
			const run = spawnSync(process.execPath, ["-e", script], { cwd: import.meta.dirname, encoding: "utf8" });
			expect(run.stderr).toBe("");
			expect(JSON.parse(run.stdout)).toEqual(
				zodToWireSchema(z.object({ name: z.string(), limit: z.number().optional() })),
			);
		});
	}
});
