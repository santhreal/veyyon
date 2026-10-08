/**
 * A gateway request schema compiles its validator in a process configured ArkType jitless.
 *
 * WHY THIS SUITE EXISTS. The CLI entry configures ArkType jitless before any schema loads, which
 * saves the codegen of every schema a launch builds. The auth gateway's request schemas validate a
 * whole conversation per request, where interpreted traversal costs about fifty times compiled, so
 * they build with the parser in `providers/gateway-schema-type.ts`, bound to a scope that compiles
 * regardless of the process setting. A schema module that builds with `arktype`'s own `type`
 * instead, or a parser scope that inherits the process setting, loses compilation in the shipped
 * binary and nowhere else, because a test process is not jitless.
 *
 * The class it closes: a gateway schema, in any `*-server-schema.ts` module under `providers/`,
 * validated by interpreted traversal in a jitless process. The modules are enumerated from the
 * directory at run time and must equal the set the fixture checks, so a new one turns this red
 * until the fixture imports it.
 *
 * WHAT IT DOES NOT CATCH: a gateway schema defined outside a `*-server-schema.ts` module, and the
 * validation speed itself; it observes that ArkType compiled the validator, not how fast it runs.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { GatewayCompilationReport } from "./fixtures/gateway-schema-compilation";

const PROVIDERS_DIR = path.join(import.meta.dirname, "..", "src", "providers");
const FIXTURE = path.join(import.meta.dirname, "fixtures", "gateway-schema-compilation.ts");

const SCHEMA_MODULES = fs
	.readdirSync(PROVIDERS_DIR)
	.filter(name => name.endsWith("-server-schema.ts"))
	.sort();

function jitlessReport(): GatewayCompilationReport {
	const run = spawnSync(process.execPath, [FIXTURE], { encoding: "utf8" });
	if (run.status !== 0) throw new Error(`gateway compilation fixture exited ${run.status}: ${run.stderr}`);
	return JSON.parse(run.stdout) as GatewayCompilationReport;
}

describe("a gateway request schema in a jitless process", () => {
	const report = jitlessReport();

	it("runs in a process where a schema built with arktype's own parser is not compiled", () => {
		expect(report.control).toBe(false);
	});

	it("is compiled when built with the gateway parser", () => {
		expect(report.parser).toBe(true);
	});

	it("is checked in every gateway schema module under providers/", () => {
		expect(Object.keys(report.modules).sort()).toEqual(SCHEMA_MODULES);
	});

	for (const moduleName of SCHEMA_MODULES) {
		it(`is compiled for every ArkType type ${moduleName} exports`, () => {
			const compiled = report.modules[moduleName] ?? {};
			const names = Object.keys(compiled);
			expect(names.length).toBeGreaterThan(0);
			expect(names.filter(name => !compiled[name])).toEqual([]);
		});
	}
});
