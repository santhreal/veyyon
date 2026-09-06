/**
 * Measures and derives the static CLI argument, command, and worker-selector surface.
 *
 * WHY THIS MODULE EXISTS. During large-scale workspace refactoring (such as PR #927 "Everything as a Plugin"),
 * files move across packages and modules change their import graphs. The CLI entrypoint, command registry,
 * flag tables, and hidden worker selectors form a public and internal contract that must not lose any
 * capability or alter flag argument-taking shapes.
 *
 * This module uses `@babel/parser` to statically parse the TypeScript AST of the CLI registry modules
 * (`cli-commands.ts`, `flag-tables.ts`, `profile-bootstrap.ts`, `worker-args.ts`, `launch/protocol.ts`, `cli.ts`)
 * and derives:
 * 1. The complete list of registered command names.
 * 2. The complete map of flags (long and short) and their argument-taking shapes (`takesValue: boolean`).
 * 3. The complete list of hidden worker argv selectors.
 *
 * AST ROUTE RATIONALE. We use `@babel/parser` to traverse the AST nodes rather than regexes because
 * commands, flags, and worker constants are structured as literal object maps, array expressions, and exported
 * constants. AST parsing handles comments, multi-line formatting, type annotations, and object property keys
 * robustly without fragile text patterns.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "@babel/parser";
import type { ArrayExpression, Node } from "@babel/types";
import { PINNED_BASELINE_COMMIT, REPO_ROOT, readGitFileText } from "./git-baseline";

export { REPO_ROOT };

export const CLI_SURFACE_SCHEMA_VERSION = 2;

export const DEFAULT_CLI_SURFACE_FIXTURE_PATH = join(REPO_ROOT, "scripts", "fixtures", "cli-surface.json");

export const CLI_SURFACE_SOURCE_PATHS = [
	"packages/coding-agent/src/cli-commands.ts",
	"packages/coding-agent/src/cli/flag-tables.ts",
	"packages/coding-agent/src/cli/profile-bootstrap.ts",
	"packages/coding-agent/src/cli.ts",
	"packages/coding-agent/src/worker-args.ts",
	"packages/coding-agent/src/launch/protocol.ts",
] as const;

export interface FlagSpec {
	takesValue: boolean;
}

export interface CliSurface {
	commands: string[];
	flags: Record<string, FlagSpec>;
	workerSelectors: string[];
}

export interface CliSurfaceAdditions {
	commands: string[];
	flags: Record<string, FlagSpec>;
	workerSelectors: string[];
}

export interface CliSurfaceApprovalLedger {
	schemaVersion: number;
	generatedFrom: string;
	additions: CliSurfaceAdditions;
}

export interface CliSurfaceLedger {
	schemaVersion: number;
	generatedFrom: string;
	commands: string[];
	flags: Record<string, FlagSpec>;
	workerSelectors: string[];
	additions: CliSurfaceAdditions;
}

export interface CliSurfaceSources {
	commandsSource: string;
	flagTablesSource: string;
	profileBootstrapSource: string;
	cliSource: string;
	workerArgsSource: string;
	protocolSource: string;
}
/**
 * Extracts command names from `packages/coding-agent/src/cli-commands.ts`.
 * Parses the exported `commands` array of `CommandEntry` objects.
 */
export function extractCommandsFromSource(source: string): string[] {
	const ast = parse(source, {
		sourceType: "module",
		plugins: ["typescript"],
	});
	const commands = new Set<string>();

	for (const stmt of ast.program.body) {
		let decl: Node = stmt;
		if (decl.type === "ExportNamedDeclaration" && decl.declaration) {
			decl = decl.declaration;
		}
		if (decl.type === "VariableDeclaration") {
			for (const declarator of decl.declarations) {
				if (declarator.id.type === "Identifier" && declarator.id.name === "commands") {
					if (declarator.init?.type === "ArrayExpression") {
						for (const element of declarator.init.elements) {
							if (element && element.type === "ObjectExpression") {
								for (const prop of element.properties) {
									if (prop.type === "ObjectProperty") {
										const keyName =
											prop.key.type === "Identifier"
												? prop.key.name
												: prop.key.type === "StringLiteral"
													? prop.key.value
													: undefined;
										if (keyName === "name" && prop.value.type === "StringLiteral") {
											commands.add(prop.value.value);
										}
									}
								}
							}
						}
					}
				}
			}
		}
	}

	return [...commands].sort();
}

/**
 * Extracts flag definitions from `packages/coding-agent/src/cli/flag-tables.ts`.
 * Reads `STRING_SETTERS` (takes value = true), `OPTIONAL_FLAGS` (takes value = true),
 * and `VALUELESS_FLAGS` (takes value = false).
 */
export function extractFlagTablesFromSource(source: string): {
	stringFlags: string[];
	optionalFlags: string[];
	valuelessFlags: string[];
} {
	const ast = parse(source, {
		sourceType: "module",
		plugins: ["typescript"],
	});
	const stringFlags = new Set<string>();
	const optionalFlags = new Set<string>();
	const valuelessFlags = new Set<string>();

	for (const stmt of ast.program.body) {
		let decl: Node = stmt;
		if (decl.type === "ExportNamedDeclaration" && decl.declaration) {
			decl = decl.declaration;
		}
		if (decl.type === "VariableDeclaration") {
			for (const declarator of decl.declarations) {
				if (declarator.id.type === "Identifier") {
					const name = declarator.id.name;
					if (name === "STRING_SETTERS" && declarator.init?.type === "ObjectExpression") {
						for (const prop of declarator.init.properties) {
							if (prop.type === "ObjectProperty") {
								const key =
									prop.key.type === "StringLiteral"
										? prop.key.value
										: prop.key.type === "Identifier"
											? prop.key.name
											: undefined;
								if (key) stringFlags.add(key);
							}
						}
					} else if (name === "OPTIONAL_FLAGS" && declarator.init?.type === "ObjectExpression") {
						for (const prop of declarator.init.properties) {
							if (prop.type === "ObjectProperty") {
								const key =
									prop.key.type === "StringLiteral"
										? prop.key.value
										: prop.key.type === "Identifier"
											? prop.key.name
											: undefined;
								if (key) optionalFlags.add(key);
							}
						}
					} else if (name === "VALUELESS_FLAGS") {
						let arrayNode: ArrayExpression | undefined;
						if (
							declarator.init?.type === "NewExpression" &&
							declarator.init.arguments[0]?.type === "ArrayExpression"
						) {
							arrayNode = declarator.init.arguments[0];
						} else if (declarator.init?.type === "ArrayExpression") {
							arrayNode = declarator.init;
						}
						if (arrayNode) {
							for (const el of arrayNode.elements) {
								if (el && el.type === "StringLiteral") {
									valuelessFlags.add(el.value);
								}
							}
						}
					}
				}
			}
		}
	}

	return {
		stringFlags: [...stringFlags].sort(),
		optionalFlags: [...optionalFlags].sort(),
		valuelessFlags: [...valuelessFlags].sort(),
	};
}

/**
 * Extracts profile bootstrap flags from `packages/coding-agent/src/cli/profile-bootstrap.ts`.
 * Identifies `--profile` and `--alias` which are consumed early.
 */
export function extractProfileFlagsFromSource(source: string): string[] {
	const ast = parse(source, {
		sourceType: "module",
		plugins: ["typescript"],
	});
	const flags = new Set<string>();

	function walk(node: Node | null | undefined): void {
		if (!node) return;
		if (node.type === "BinaryExpression" && (node.operator === "===" || node.operator === "==")) {
			if (node.left.type === "Identifier" && node.left.name === "arg" && node.right.type === "StringLiteral") {
				if (node.right.value.startsWith("-")) flags.add(node.right.value);
			} else if (
				node.right.type === "Identifier" &&
				node.right.name === "arg" &&
				node.left.type === "StringLiteral"
			) {
				if (node.left.value.startsWith("-")) flags.add(node.left.value);
			}
		}
		for (const key of Object.keys(node)) {
			const child = (node as unknown as Record<string, unknown>)[key];
			if (child && typeof child === "object") {
				if (Array.isArray(child)) {
					for (const item of child) {
						if (item && typeof item === "object" && "type" in item) walk(item as Node);
					}
				} else if ("type" in child) {
					walk(child as Node);
				}
			}
		}
	}

	walk(ast.program);
	flags.add("--profile");
	flags.add("--alias");
	return [...flags].sort();
}

/**
 * Extracts special root CLI flags from `packages/coding-agent/src/cli.ts` (such as `--smoke-test`).
 */
export function extractCliFlagsFromSource(source: string): string[] {
	const ast = parse(source, {
		sourceType: "module",
		plugins: ["typescript"],
	});
	const flags = new Set<string>();

	function walk(node: Node | null | undefined): void {
		if (!node) return;
		if (node.type === "BinaryExpression" && (node.operator === "===" || node.operator === "==")) {
			if (node.left.type === "MemberExpression" || node.left.type === "OptionalMemberExpression") {
				if (node.right.type === "StringLiteral" && node.right.value.startsWith("-")) {
					flags.add(node.right.value);
				}
			} else if (node.right.type === "MemberExpression" || node.right.type === "OptionalMemberExpression") {
				if (node.left.type === "StringLiteral" && node.left.value.startsWith("-")) {
					flags.add(node.left.value);
				}
			}
		}
		for (const key of Object.keys(node)) {
			const child = (node as unknown as Record<string, unknown>)[key];
			if (child && typeof child === "object") {
				if (Array.isArray(child)) {
					for (const item of child) {
						if (item && typeof item === "object" && "type" in item) walk(item as Node);
					}
				} else if ("type" in child) {
					walk(child as Node);
				}
			}
		}
	}

	walk(ast.program);
	return [...flags].sort();
}

/**
 * Extracts worker selectors from `packages/coding-agent/src/worker-args.ts`.
 */
export function extractWorkerArgsFromSource(source: string): string[] {
	const ast = parse(source, {
		sourceType: "module",
		plugins: ["typescript"],
	});
	const selectors = new Set<string>();

	for (const stmt of ast.program.body) {
		let decl: Node = stmt;
		if (decl.type === "ExportNamedDeclaration" && decl.declaration) {
			decl = decl.declaration;
		}
		if (decl.type === "VariableDeclaration") {
			for (const declarator of decl.declarations) {
				if (declarator.init?.type === "StringLiteral" && declarator.init.value.startsWith("__")) {
					selectors.add(declarator.init.value);
				}
			}
		}
	}

	return [...selectors].sort();
}

/**
 * Extracts daemon broker worker selector from `packages/coding-agent/src/launch/protocol.ts`.
 */
export function extractProtocolWorkerArgsFromSource(source: string): string[] {
	const ast = parse(source, {
		sourceType: "module",
		plugins: ["typescript"],
	});
	const selectors = new Set<string>();

	for (const stmt of ast.program.body) {
		let decl: Node = stmt;
		if (decl.type === "ExportNamedDeclaration" && decl.declaration) {
			decl = decl.declaration;
		}
		if (decl.type === "VariableDeclaration") {
			for (const declarator of decl.declarations) {
				if (
					declarator.id.type === "Identifier" &&
					declarator.id.name === "DAEMON_BROKER_WORKER_ARG" &&
					declarator.init?.type === "StringLiteral"
				) {
					selectors.add(declarator.init.value);
				}
			}
		}
	}

	return [...selectors].sort();
}

/**
 * Derives the complete CLI surface from raw source strings of the six CLI registry files.
 */
export function deriveCliSurfaceFromSources(sources: CliSurfaceSources): CliSurface {
	const commands = extractCommandsFromSource(sources.commandsSource);
	const { stringFlags, optionalFlags, valuelessFlags } = extractFlagTablesFromSource(sources.flagTablesSource);
	const profileFlags = extractProfileFlagsFromSource(sources.profileBootstrapSource);
	const cliFlags = extractCliFlagsFromSource(sources.cliSource);

	const flags: Record<string, FlagSpec> = {};
	for (const flag of stringFlags) {
		flags[flag] = { takesValue: true };
	}
	for (const flag of optionalFlags) {
		flags[flag] = { takesValue: true };
	}
	for (const flag of profileFlags) {
		flags[flag] = { takesValue: true };
	}
	for (const flag of valuelessFlags) {
		flags[flag] = { takesValue: false };
	}
	for (const flag of cliFlags) {
		if (!(flag in flags)) {
			flags[flag] = { takesValue: false };
		}
	}

	const workerArgs = extractWorkerArgsFromSource(sources.workerArgsSource);
	const protocolWorkerArgs = extractProtocolWorkerArgsFromSource(sources.protocolSource);
	const workerSelectors = [...new Set([...workerArgs, ...protocolWorkerArgs])].sort();

	const sortedFlags: Record<string, FlagSpec> = {};
	for (const key of Object.keys(flags).sort()) {
		sortedFlags[key] = flags[key];
	}

	return {
		commands,
		flags: sortedFlags,
		workerSelectors,
	};
}

/**
 * Derives the complete CLI surface from the given repository root directory on disk.
 */
export function deriveCliSurface(root = REPO_ROOT): CliSurface {
	const codingAgentSrc = join(root, "packages", "coding-agent", "src");
	return deriveCliSurfaceFromSources({
		commandsSource: readFileSync(join(codingAgentSrc, "cli-commands.ts"), "utf-8"),
		flagTablesSource: readFileSync(join(codingAgentSrc, "cli", "flag-tables.ts"), "utf-8"),
		profileBootstrapSource: readFileSync(join(codingAgentSrc, "cli", "profile-bootstrap.ts"), "utf-8"),
		cliSource: readFileSync(join(codingAgentSrc, "cli.ts"), "utf-8"),
		workerArgsSource: readFileSync(join(codingAgentSrc, "worker-args.ts"), "utf-8"),
		protocolSource: readFileSync(join(codingAgentSrc, "launch", "protocol.ts"), "utf-8"),
	});
}

/**
 * Measures the baseline CLI surface dynamically from a Git commit using immutable historical blobs.
 */
export function measureCliSurfaceFromGit(commit = PINNED_BASELINE_COMMIT, repoRoot = REPO_ROOT): CliSurface {
	const readSource = (relativePath: string): string => {
		const source = readGitFileText(relativePath, commit, repoRoot);
		if (source === null) {
			throw new Error(`Required CLI surface source file ${relativePath} is missing in git commit ${commit}`);
		}
		return source;
	};
	return deriveCliSurfaceFromSources({
		commandsSource: readSource(CLI_SURFACE_SOURCE_PATHS[0]),
		flagTablesSource: readSource(CLI_SURFACE_SOURCE_PATHS[1]),
		profileBootstrapSource: readSource(CLI_SURFACE_SOURCE_PATHS[2]),
		cliSource: readSource(CLI_SURFACE_SOURCE_PATHS[3]),
		workerArgsSource: readSource(CLI_SURFACE_SOURCE_PATHS[4]),
		protocolSource: readSource(CLI_SURFACE_SOURCE_PATHS[5]),
	});
}

/**
 * Validates the raw JSON payload of the sparse CLI surface approval ledger.
 * Enforces fail-closed rejection on malformed, unversioned, stale, or corrupt structures.
 */
export function validateCliSurfaceApprovalLedger(raw: unknown): CliSurfaceApprovalLedger {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("CLI surface ledger is not an object");
	}
	const ledger = raw as Partial<CliSurfaceApprovalLedger>;
	if (ledger.schemaVersion !== CLI_SURFACE_SCHEMA_VERSION) {
		throw new Error(
			`CLI surface ledger schema is stale or unversioned (expected version ${CLI_SURFACE_SCHEMA_VERSION}, got ${ledger.schemaVersion ?? "unversioned v1"})`,
		);
	}
	if (ledger.generatedFrom !== PINNED_BASELINE_COMMIT) {
		throw new Error(
			`CLI surface ledger generatedFrom commit mismatch: expected pinned baseline ${PINNED_BASELINE_COMMIT}, got ${ledger.generatedFrom ?? "missing"}`,
		);
	}
	if (!ledger.additions || typeof ledger.additions !== "object" || Array.isArray(ledger.additions)) {
		throw new Error("CLI surface ledger is missing additions record");
	}
	if (
		!Array.isArray(ledger.additions.commands) ||
		!ledger.additions.commands.every(command => typeof command === "string")
	) {
		throw new Error("CLI surface ledger additions.commands must be an array");
	}
	if (!ledger.additions.flags || typeof ledger.additions.flags !== "object" || Array.isArray(ledger.additions.flags)) {
		throw new Error("CLI surface ledger additions.flags must be an object");
	}
	for (const [flag, spec] of Object.entries(ledger.additions.flags)) {
		if (!spec || typeof spec !== "object" || typeof (spec as FlagSpec).takesValue !== "boolean") {
			throw new Error(`CLI surface ledger flag spec for "${flag}" must have boolean takesValue`);
		}
	}
	if (
		!Array.isArray(ledger.additions.workerSelectors) ||
		!ledger.additions.workerSelectors.every(selector => typeof selector === "string")
	) {
		throw new Error("CLI surface ledger additions.workerSelectors must be an array");
	}

	return raw as CliSurfaceApprovalLedger;
}

/**
 * Loads the CLI surface ledger from fixture, validating the approval ledger and
 * dynamically reconstructing baseline commands, flags, and worker selectors from immutable Git.
 */
export function loadCliSurfaceLedger(
	fixturePath = DEFAULT_CLI_SURFACE_FIXTURE_PATH,
	repoRoot = REPO_ROOT,
): CliSurfaceLedger {
	if (!existsSync(fixturePath)) {
		throw new Error(
			`CLI surface ledger fixture not found at ${fixturePath}.\n` +
				`Corrective action: Run 'bun scripts/measure-cli-surface.ts' to generate the ledger.`,
		);
	}
	const raw = JSON.parse(readFileSync(fixturePath, "utf-8")) as unknown;
	const approval = validateCliSurfaceApprovalLedger(raw);
	const baseSurface = measureCliSurfaceFromGit(approval.generatedFrom, repoRoot);

	return {
		schemaVersion: approval.schemaVersion,
		generatedFrom: approval.generatedFrom,
		commands: baseSurface.commands,
		flags: baseSurface.flags,
		workerSelectors: baseSurface.workerSelectors,
		additions: approval.additions,
	};
}

/**
 * Builds a full ledger comparing base surface against the current surface.
 */
export function buildLedger(
	baseSurface: CliSurface,
	currentSurface: CliSurface,
	generatedFrom: string = PINNED_BASELINE_COMMIT,
): CliSurfaceLedger {
	const baseCommandSet = new Set(baseSurface.commands);
	const addedCommands = currentSurface.commands.filter(c => !baseCommandSet.has(c));

	const addedFlags: Record<string, FlagSpec> = {};
	for (const [flag, spec] of Object.entries(currentSurface.flags)) {
		if (!(flag in baseSurface.flags)) {
			addedFlags[flag] = spec;
		}
	}

	const baseWorkerSet = new Set(baseSurface.workerSelectors);
	const addedWorkerSelectors = currentSurface.workerSelectors.filter(w => !baseWorkerSet.has(w));

	return {
		schemaVersion: CLI_SURFACE_SCHEMA_VERSION,
		generatedFrom,
		commands: baseSurface.commands,
		flags: baseSurface.flags,
		workerSelectors: baseSurface.workerSelectors,
		additions: {
			commands: addedCommands,
			flags: addedFlags,
			workerSelectors: addedWorkerSelectors,
		},
	};
}

/**
 * Builds a sparse approval ledger comparing base surface against current surface.
 */
export function buildApprovalLedger(
	baseSurface: CliSurface,
	currentSurface: CliSurface,
	generatedFrom: string = PINNED_BASELINE_COMMIT,
): CliSurfaceApprovalLedger {
	const full = buildLedger(baseSurface, currentSurface, generatedFrom);
	return {
		schemaVersion: full.schemaVersion,
		generatedFrom: full.generatedFrom,
		additions: full.additions,
	};
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const baseFlag = args.indexOf("--base");
	const shaFlag = args.indexOf("--from");
	const fullFlag = args.includes("--full");

	const generatedFrom = shaFlag === -1 ? PINNED_BASELINE_COMMIT : (args[shaFlag + 1] ?? "");
	if (generatedFrom === "") {
		process.stderr.write("--from needs a sha\n");
		process.exit(2);
	}

	let baseSurface: CliSurface;
	if (baseFlag !== -1 && args[baseFlag + 1] !== undefined) {
		const baseRoot = resolve(args[baseFlag + 1]);
		baseSurface = deriveCliSurface(baseRoot);
	} else {
		baseSurface = measureCliSurfaceFromGit(generatedFrom, REPO_ROOT);
	}

	const currentSurface = deriveCliSurface(REPO_ROOT);
	const outPath = DEFAULT_CLI_SURFACE_FIXTURE_PATH;

	if (fullFlag) {
		const fullLedger = buildLedger(baseSurface, currentSurface, generatedFrom);
		writeFileSync(outPath, `${JSON.stringify(fullLedger, null, "\t")}\n`, "utf-8");
		process.stdout.write(
			`Wrote full CLI surface ledger to ${outPath}: ${fullLedger.commands.length} commands, ` +
				`${Object.keys(fullLedger.flags).length} flags, ${fullLedger.workerSelectors.length} worker selectors (from ${generatedFrom})\n`,
		);
	} else {
		const approvalLedger = buildApprovalLedger(baseSurface, currentSurface, generatedFrom);
		writeFileSync(outPath, `${JSON.stringify(approvalLedger, null, "\t")}\n`, "utf-8");
		process.stdout.write(
			`Wrote sparse CLI surface approval fixture to ${outPath}: ${approvalLedger.additions.commands.length} added commands, ` +
				`${Object.keys(approvalLedger.additions.flags).length} added flags, ${approvalLedger.additions.workerSelectors.length} added worker selectors (pinned to ${generatedFrom})\n`,
		);
	}
}
