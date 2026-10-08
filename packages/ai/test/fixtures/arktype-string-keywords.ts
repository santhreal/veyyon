/**
 * Prints as JSON what ArkType's `string.*` keywords did in this process: the nodes each top-level
 * keyword registered on its first read, whether its second read returned the same value, which nodes
 * a keyword references that already existed once `arktype` evaluated, and, for every keyword path,
 * its expression, its description, the scope the `string` module binds it to, whether its node holds
 * a compiled traversal, and a digest of what it returned for each input of {@link CORPUS} through
 * four routes: the exported `keywords.string` module, a `type` definition, a definition in a user
 * scope and the `string` module `arktype/internal/keywords/string.js` exports.
 *
 * Run as its own process, with `TZ=UTC` so a parsed date has one serialization: the arguments
 * `arktype-string-keyword-config.ts` reads configure ArkType when `arktype` first evaluates, which a
 * test process that already loaded it cannot observe.
 */
import "./arktype-string-keyword-config";
import { createHash } from "node:crypto";
import { ArkErrors, keywords, scope, type } from "arktype";
import { string as stringKeywordModule } from "arktype/internal/keywords/string.js";
import { type ArkNode, registeredNodes } from "./arktype-lazy-members";

/** Strings that each `string.*` keyword accepts or rejects in some way it can be told apart by. */
const CORPUS = [
	"",
	"abc",
	"ABC",
	"Abc",
	"abc1",
	"123",
	"-12",
	"1.5",
	"0012",
	"deadBEEF",
	"aGVsbG8=",
	"aGVsbG8",
	"aGV-bG8_",
	"4111111111111111",
	"4111111111111112",
	"2020-01-01",
	"2020-01-01T00:00:00.000Z",
	"01/02/2020",
	"1700000000",
	"99999999999999999999",
	"not a date",
	"a@b.co",
	"not-an-email",
	"127.0.0.1",
	"::1",
	"256.1.1.1",
	"fe80::1%eth0",
	'{"a":1}',
	"{bad",
	"1.2.3",
	"1.2.3-beta.1+build",
	"v1.2",
	" padded ",
	"trimmed",
	"caf\u00e9",
	"cafe\u0301",
	"https://example.com/x?y=1",
	"not a url",
	"f47ac10b-58cc-4372-a567-0e02b2c3d479",
	"c232ab00-9414-11ec-b3c8-9f6bdeced846",
	"017f22e2-79b0-7cc3-98c4-dc0c0c07398f",
	"00000000-0000-0000-0000-000000000000",
	"[a-z]+",
	"(",
] as const;

/** Values that are not strings, which every `string.*` keyword rejects. */
const NON_STRINGS = [42, null, true, undefined] as const;

export interface KeywordPath {
	expression: string;
	description: string;
	/**
	 * The first 16 hex digits of the SHA-256 of what the keyword returned for each corpus string and
	 * whether it allows each non-string, identical through every route a definition reaches it by.
	 */
	outcomes: string;
	/** The scope the keyword's node is bound to in the `string` module `arktype/internal/keywords/string.js` exports. */
	moduleScope: string;
}

export interface StringKeywordReport {
	/** The keywords under `string`, in the order the module defines them. */
	aliases: string[];
	/** For each keyword, the nodes its first read registered. */
	firstReadNodes: Record<string, number>;
	/** Keywords whose second read returned a different value from their first. */
	rereadDiffers: string[];
	/** The expression of every node a keyword path references that existed once `arktype` evaluated. Sorted. */
	builtAtImport: string[];
	/** Keyword paths whose routes returned different outcomes. */
	routesDisagree: string[];
	/** Keyword paths for which some route returned a node with no compiled traversal. */
	uncompiled: string[];
	/** Every keyword path under `string`, by the definition that names it without `string.`. */
	paths: Record<string, KeywordPath>;
}

interface KeywordType {
	(data: unknown): unknown;
	readonly expression: string;
	readonly description: string;
	allows(data: unknown): boolean;
	readonly internal: {
		readonly referencesById: Readonly<Record<string, ArkNode>>;
		readonly precompilation?: string;
		readonly $: { readonly name: string };
	};
}

function isKeywordType(value: unknown): value is KeywordType {
	return (
		typeof value === "function" &&
		typeof Reflect.get(value, "expression") === "string" &&
		typeof Reflect.get(value, "allows") === "function"
	);
}

function serialize(value: unknown): string {
	if (value instanceof Date) return Number.isNaN(value.valueOf()) ? "Date(invalid)" : `Date(${value.toISOString()})`;
	if (value instanceof URL) return `URL(${value.href})`;
	return value === undefined ? "undefined" : JSON.stringify(value);
}

function outcomesOf(keyword: KeywordType): string[] {
	const outcomes = CORPUS.map(input => {
		const out = keyword(input);
		return out instanceof ArkErrors ? `E:${out.summary}` : `A:${serialize(out)}`;
	});
	for (const input of NON_STRINGS) outcomes.push(`allows:${keyword.allows(input)}`);
	return outcomes;
}

function digest(outcomes: string[]): string {
	return createHash("sha256").update(outcomes.join("\n")).digest("hex").slice(0, 16);
}

/**
 * Every keyword path under `module`: the definition suffix that names it, the member names that reach
 * it from the module, and the type the module holds there.
 */
function keywordPaths(module: object, members: string[]): Array<[string, string[], KeywordType]> {
	const paths: Array<[string, string[], KeywordType]> = [];
	for (const alias of Object.getOwnPropertyNames(module)) {
		const value: unknown = Reflect.get(module, alias);
		const path = [...members, alias];
		if (isKeywordType(value)) {
			const named = alias === "root" ? members : path;
			if (named.length > 0) paths.push([named.join("."), path, value]);
		} else if (typeof value === "object" && value !== null) {
			paths.push(...keywordPaths(value, path));
		}
	}
	return paths;
}

function memberAt(module: object, members: string[]): unknown {
	let value: unknown = module;
	for (const member of members)
		value = typeof value === "object" && value !== null ? Reflect.get(value, member) : undefined;
	return value;
}

const importIds = new Set([...registeredNodes()].map(node => node.id));
const stringModule: object = keywords.string;
const aliases = Object.getOwnPropertyNames(stringModule).filter(alias => alias !== "root");

const firstReadNodes: Record<string, number> = {};
const rereadDiffers: string[] = [];
for (const alias of aliases) {
	const before = registeredNodes().size;
	const first: unknown = Reflect.get(stringModule, alias);
	firstReadNodes[alias] = registeredNodes().size - before;
	if (!Object.is(Reflect.get(stringModule, alias), first)) rereadDiffers.push(alias);
}

const builtAtImport = new Set<string>();
const routesDisagree: string[] = [];
const uncompiled: string[] = [];
const paths: Record<string, KeywordPath> = {};
const userScope = scope({});
for (const [path, members, exported] of keywordPaths(stringModule, [])) {
	const definition = `string.${path}`;
	const parsed = type.raw(definition);
	const scoped = userScope.type.raw(definition);
	const moduleMember = memberAt(stringKeywordModule, members);
	if (!isKeywordType(parsed) || !isKeywordType(scoped) || !isKeywordType(moduleMember)) {
		throw new Error(`${definition} did not resolve to a type through every route`);
	}
	const outcomes = outcomesOf(exported);
	const routes = [outcomes, outcomesOf(parsed), outcomesOf(scoped), outcomesOf(moduleMember)].map(digest);
	if (new Set(routes).size !== 1) routesDisagree.push(path);
	if ([exported, parsed, scoped, moduleMember].some(keyword => typeof keyword.internal.precompilation !== "string")) {
		uncompiled.push(path);
	}
	paths[path] = {
		expression: exported.expression,
		description: exported.description,
		outcomes: routes[0],
		moduleScope: moduleMember.internal.$.name,
	};
	for (const [id, node] of Object.entries(exported.internal.referencesById)) {
		const expression: unknown = Reflect.get(node, "expression");
		if (importIds.has(id)) builtAtImport.add(typeof expression === "string" ? expression : id);
	}
}

const report: StringKeywordReport = {
	aliases,
	firstReadNodes,
	rereadDiffers,
	builtAtImport: [...builtAtImport].sort(),
	routesDisagree,
	uncompiled,
	paths,
};
process.stdout.write(JSON.stringify(report));
