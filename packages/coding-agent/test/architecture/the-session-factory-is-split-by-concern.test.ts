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
 * `createAgentSession` itself is split only where a concern owns its state. The
 * secret runtime (the lease, the obfuscator pair, the vault revision, the reload
 * queue) moved to `SessionSecretRuntime` in `src/secrets/session-runtime.ts`,
 * which holds that state as fields instead of as captured locals, and the lease
 * each request in flight was admitted under moved to `SecretRequestLeases` in
 * `src/secrets/request-leases.ts`. The tool
 * session (the mutation counters, the active-tool set, the host notifier and the
 * advisor's derived view) moved to `src/session/tool-session.ts`. The project
 * the system prompt renders (its snapshot, the serialized re-discovery on a cwd
 * move and the TTSR rollback) moved to `ProjectPromptInputs` in
 * `src/session/prompt-inputs.ts`; MCP startup and its reactive wiring moved into
 * `factory-mcp.ts`. The startup phases that read their inputs and return a value
 * moved beside it: the custom tools and the tool registry into `factory-tools.ts`,
 * the tool discovery mode into `tool-discovery.ts`, the extensions, their provider
 * adoption, the custom commands, the prompt templates and slash commands into
 * `startup-extensions.ts`, the Codex prewarm, language-server warmup and memory
 * hydration into `startup-background.ts`, the argot arm and the start records into
 * `startup-records.ts`, the agent identity and provider prompt cache key into
 * `startup-identity.ts`, the per-request hooks into `startup-request-hooks.ts`, the
 * credential-disabled relay into `startup-credential-relay.ts`, and the owned
 * background-job manager into `async-jobs.ts`. The rest is `SessionStartup`, one
 * class whose steps run in order and whose fields hold what a later step reads and
 * what `abandon` releases when a step throws. The plan's `factory-providers.ts`,
 * `factory-memory.ts` and `factory-advisor.ts` have no free declarations to hold
 * and are absent rather than empty. The ceiling below records where the file is.
 *
 * What it does not catch: a factory module that keeps its name and grows a
 * concern that belongs to another, and the coupling between the steps of
 * `SessionStartup`, which no gate here measures.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { importSpecifiers, lineCount, repoPath, valueImportSpecifiers } from "./helpers/module-graph";

const SESSION_DIR = repoPath("packages/coding-agent/src/session");
const SDK = repoPath("packages/coding-agent/src/sdk.ts");

/**
 * MEASURED at 1646 lines after `createAgentSession` became the `SessionStartup` steps and the
 * request hooks, the agent identity, the provider prompt cache key, the credential-disabled relay,
 * the tool discovery mode, the command input discovery and the memory hydration moved into
 * `src/session/` modules. This falls when `SessionStartup` is split again.
 */
const SDK_CEILING = 1646;

/** MEASURED: the largest factory module is `factory-extensions.ts` at 395 lines. */
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
