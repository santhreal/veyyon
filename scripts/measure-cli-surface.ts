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

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "@babel/parser";
import type { ArrayExpression, Node } from "@babel/types";

/** Repository root path derived from this script's location. */
export const REPO_ROOT = resolve(import.meta.dirname, "..");

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

export interface CliSurfaceLedger {
	generatedFrom: string;
	commands: string[];
	flags: Record<string, FlagSpec>;
	workerSelectors: string[];
	additions: CliSurfaceAdditions;
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
 * Derives the complete CLI surface from the given repository root directory.
 */
export function deriveCliSurface(root = REPO_ROOT): CliSurface {
	const codingAgentSrc = join(root, "packages", "coding-agent", "src");

	// 1. Commands
	const commandsPath = join(codingAgentSrc, "cli-commands.ts");
	const commandsSource = readFileSync(commandsPath, "utf-8");
	const commands = extractCommandsFromSource(commandsSource);

	// 2. Flags
	const flagTablesPath = join(codingAgentSrc, "cli", "flag-tables.ts");
	const flagTablesSource = readFileSync(flagTablesPath, "utf-8");
	const { stringFlags, optionalFlags, valuelessFlags } = extractFlagTablesFromSource(flagTablesSource);

	const profileBootstrapPath = join(codingAgentSrc, "cli", "profile-bootstrap.ts");
	const profileBootstrapSource = readFileSync(profileBootstrapPath, "utf-8");
	const profileFlags = extractProfileFlagsFromSource(profileBootstrapSource);

	const cliPath = join(codingAgentSrc, "cli.ts");
	const cliSource = readFileSync(cliPath, "utf-8");
	const cliFlags = extractCliFlagsFromSource(cliSource);

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

	// 3. Worker selectors
	const workerArgsPath = join(codingAgentSrc, "worker-args.ts");
	const workerArgsSource = readFileSync(workerArgsPath, "utf-8");
	const workerArgs = extractWorkerArgsFromSource(workerArgsSource);

	const protocolPath = join(codingAgentSrc, "launch", "protocol.ts");
	const protocolSource = readFileSync(protocolPath, "utf-8");
	const protocolWorkerArgs = extractProtocolWorkerArgsFromSource(protocolSource);

	const workerSelectors = [...new Set([...workerArgs, ...protocolWorkerArgs])].sort();

	// Sort flags alphabetically
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
 * Builds a ledger comparing origin/main baseline against the current surface.
 */
export function buildLedger(
	baseSurface: CliSurface,
	currentSurface: CliSurface,
	generatedFrom: string,
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

if (import.meta.main) {
	// The ledger's rows are main's surface, so they cannot be read from this tree. A baseline root
	// holding main's checkout of the six extracted modules is required: deriving both sides from the
	// working tree would re-baseline the ledger on every regeneration and could never see a removal.
	const args = process.argv.slice(2);
	const baseFlag = args.indexOf("--base");
	const shaFlag = args.indexOf("--from");
	if (baseFlag === -1 || args[baseFlag + 1] === undefined) {
		process.stderr.write("usage: measure-cli-surface.ts --base <main-checkout-root> [--from <sha>]\n");
		process.exit(2);
	}
	const baseRoot = resolve(args[baseFlag + 1]);
	const generatedFrom = shaFlag === -1 ? "e9467ab12c976cd830eb7a61e30bfd6adc4bff1f" : (args[shaFlag + 1] ?? "");
	if (generatedFrom === "") {
		process.stderr.write("--from needs a sha\n");
		process.exit(2);
	}

	const ledger = buildLedger(deriveCliSurface(baseRoot), deriveCliSurface(REPO_ROOT), generatedFrom);
	const outPath = join(REPO_ROOT, "scripts", "fixtures", "cli-surface.json");
	writeFileSync(outPath, `${JSON.stringify(ledger, null, "\t")}\n`, "utf-8");
	process.stdout.write(
		`Wrote CLI surface ledger to ${outPath}: ${ledger.commands.length} commands, ` +
			`${Object.keys(ledger.flags).length} flags, ${ledger.workerSelectors.length} worker selectors from ${baseRoot}\n`,
	);
}
