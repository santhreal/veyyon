/**
 * WHY: `sdk.ts` was 4861 lines, and 985 of them were free declarations sitting
 * beside `createAgentSession` — the options record, the on-disk discovery
 * wrappers, the system-prompt builder, the custom-tool plumbing, the MCP
 * placeholders and the batch-notice builders. A caller that only needed to name
 * `CreateAgentSessionOptions` imported the whole composition root. They now live
 * in six `src/session/factory-*.ts` modules.
 *
 * The defect class this closes is a factory module that stops being a leaf: one
 * that imports back from `sdk.ts` (which makes the pair one module in two files),
 * one that reaches into the terminal, or a seventh appearing without a decision.
 * The module set is read off the directory at run time, so adding one turns this
 * red until it is recorded here.
 *
 * `createAgentSession` itself did NOT move and is not further split. It is one
 * 3477-line `try`/`catch` whose inner closures capture about thirty mutable
 * locals — the secret runtime lease, the obfuscator pair, the vault revision, the
 * MCP manager, the teardown flags the `catch` block reads. Turning those captures
 * into parameters is a rewrite of the startup ordering and the failure path, not
 * a move, so the plan's `factory-providers.ts`, `factory-memory.ts` and
 * `factory-advisor.ts` have no free declarations to hold and are absent rather
 * than empty. The ceiling below records where the file is.
 *
 * What it does not catch: a factory module that keeps its name and grows a
 * concern that belongs to another, and the coupling inside `createAgentSession`,
 * which no gate here measures.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { importSpecifiers, lineCount, repoPath, valueImportSpecifiers } from "./helpers/module-graph";

const SESSION_DIR = repoPath("packages/coding-agent/src/session");
const SDK = repoPath("packages/coding-agent/src/sdk.ts");

/**
 * MEASURED at 3832 lines after the free declarations moved out, of which
 * `createAgentSession` is 3477. This falls when that function is rewritten.
 */
const SDK_CEILING = 3950;

/** MEASURED: the largest factory module is `factory-options.ts` at 369 lines. */
const FACTORY_CEILING = 400;

/**
 * The six concerns that left `sdk.ts`, pinned by exact equality. A seventh, or a
 * rename, fails here before it fails anywhere useful.
 */
const FACTORIES = [
	"factory-extensions.ts",
	"factory-mcp.ts",
	"factory-notices.ts",
	"factory-options.ts",
	"factory-prompt.ts",
	"factory-tools.ts",
] as const;

function factoryFiles(): string[] {
	return readdirSync(SESSION_DIR)
		.filter(name => name.startsWith("factory-") && name.endsWith(".ts"))
		.sort();
}

describe("the modules the session factory was split into", () => {
	it("are exactly the six concerns that left it", () => {
		expect(factoryFiles()).toEqual([...FACTORIES]);
	});

	it("never import back from sdk.ts", () => {
		const offenders: string[] = [];
		for (const name of factoryFiles()) {
			for (const specifier of importSpecifiers(`${SESSION_DIR}/${name}`)) {
				const resolved = specifier.replace(/\.ts$/, "");
				if (resolved === "../sdk" || resolved.endsWith("/coding-agent/sdk"))
					offenders.push(`${name} -> ${specifier}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("name no terminal module", () => {
		const offenders: string[] = [];
		for (const name of factoryFiles()) {
			for (const specifier of valueImportSpecifiers(`${SESSION_DIR}/${name}`)) {
				if (/(^|\/)modes\/(terminal|acp|rpc)(\/|$)/.test(specifier)) offenders.push(`${name} -> ${specifier}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("stay under the measured factory ceiling", () => {
		const oversized = factoryFiles()
			.map(name => ({ name, lines: lineCount(`${SESSION_DIR}/${name}`) }))
			.filter(entry => entry.lines > FACTORY_CEILING);
		expect(oversized).toEqual([]);
	});
});

describe("the composition root's size", () => {
	it("stays under the measured ceiling", () => {
		expect(lineCount(SDK)).toBeLessThanOrEqual(SDK_CEILING);
	});

	it("has a ceiling tight enough to fail on real growth", () => {
		expect(SDK_CEILING).toBeLessThanOrEqual(Math.round(lineCount(SDK) * 1.05));
	});

	it("is larger than every module it delegates to, so nothing hid a rewrite in a factory", () => {
		const sdk = lineCount(SDK);
		for (const name of factoryFiles()) expect(lineCount(`${SESSION_DIR}/${name}`)).toBeLessThan(sdk);
	});
});
