import Handlebars from "handlebars";
import { levenshteinDistance } from "./levenshtein";

export type TemplateVariableUse = "interpolated" | "conditional";

export interface TemplateVariable {
	readonly name: string;
	readonly use: TemplateVariableUse;
	readonly paths: readonly string[];
	readonly requiredWhen: readonly (readonly string[])[];
}

export interface TemplateVariables {
	readonly required: readonly TemplateVariable[];
	readonly optional: readonly TemplateVariable[];
}

const RESCOPING_BLOCKS: ReadonlySet<string> = new Set(["each", "with", "list", "table"]);

const GUARDING_HELPERS: ReadonlySet<string> = new Set([
	"if",
	"with",
	"each",
	"list",
	"table",
	"has",
	"when",
	"ifAny",
	"ifAll",
	"default",
]);

const BUILTIN_ROOTS: ReadonlySet<string> = new Set(["this", ".", "@root", "@index", "@key", "@first", "@last", "else"]);

interface PathExpressionNode {
	type: "PathExpression";
	parts: string[];
	original: string;
	depth: number;
	data: boolean;
}

interface SubExpressionNode {
	type: "SubExpression";
	path: PathExpressionNode;
	params: Node[];
	hash?: { pairs: { value: Node }[] };
}

type Node = {
	type: string;
	path?: PathExpressionNode;
	params?: Node[];
	hash?: { pairs: { value: Node }[] };
	program?: { body: Node[] };
	inverse?: { body: Node[] };
	body?: Node[];
};

interface Sighting {
	use: TemplateVariableUse;
	path: string;
	guards: readonly string[];
}

interface Frame {
	readonly guarded: ReadonlySet<string>;
	readonly atRootScope: boolean;
}

function isPath(node: Node | undefined): node is Node & { type: "PathExpression" } {
	return node?.type === "PathExpression";
}

function isSubExpression(node: Node | undefined): node is Node & SubExpressionNode {
	return node?.type === "SubExpression";
}

function contextRoot(path: PathExpressionNode): string | null {
	if (path.data) {
		if (path.parts[0] === "root" && path.parts.length > 1) return path.parts[1] ?? null;
		return null;
	}
	const root = path.parts[0];
	if (!root) return null;
	if (BUILTIN_ROOTS.has(root)) return null;
	return root;
}

export interface AnalyzeOptions {
	readonly helperNames?: Iterable<string>;
}

export function analyzeTemplate(template: string, options: AnalyzeOptions = {}): TemplateVariables {
	const ast = Handlebars.parse(template) as unknown as Node;
	const sightings = new Map<string, Sighting[]>();
	const helperNames = new Set(Object.keys(Handlebars.helpers).concat(Array.from(options.helperNames ?? [])));

	function record(path: PathExpressionNode, use: TemplateVariableUse, frame: Frame): void {
		const root = contextRoot(path);
		if (root === null) return;
		if (!frame.atRootScope && path.depth === 0 && !path.data) return;
		const effective: TemplateVariableUse = use === "interpolated" && frame.guarded.has(root) ? "conditional" : use;
		const list = sightings.get(root) ?? [];
		list.push({ use: effective, path: path.original, guards: Array.from(frame.guarded) });
		sightings.set(root, list);
	}

	function visitArguments(node: Node, frame: Frame): void {
		for (const param of node.params ?? []) {
			if (isPath(param)) record(param as unknown as PathExpressionNode, "conditional", frame);
			else if (isSubExpression(param)) visitArguments(param as unknown as Node, frame);
		}
		for (const pair of node.hash?.pairs ?? []) {
			const value = pair.value;
			if (isPath(value)) record(value as unknown as PathExpressionNode, "conditional", frame);
			else if (isSubExpression(value)) visitArguments(value as unknown as Node, frame);
		}
	}

	function guardsFrom(node: Node, frame: Frame): Set<string> {
		const roots = new Set<string>();
		const collect = (n: Node): void => {
			for (const param of n.params ?? []) {
				if (isPath(param)) {
					const root = contextRoot(param as unknown as PathExpressionNode);
					if (root !== null) roots.add(root);
				} else if (isSubExpression(param)) collect(param as unknown as Node);
			}
		};
		collect(node);
		return new Set(Array.from(frame.guarded).concat(Array.from(roots)));
	}

	function visit(nodes: readonly Node[], frame: Frame): void {
		for (const node of nodes) {
			if (node.type === "MustacheStatement") {
				const path = node.path;
				if (!path) continue;
				const name = path.parts[0];
				const isHelperCall = (node.params?.length ?? 0) > 0 || (node.hash?.pairs?.length ?? 0) > 0;
				if (isHelperCall || (name !== undefined && helperNames.has(name) && path.parts.length === 1)) {
					visitArguments(node, frame);
				} else {
					record(path, "interpolated", frame);
				}
				continue;
			}

			if (node.type === "BlockStatement") {
				const helper = node.path?.parts[0] ?? "";
				visitArguments(node, frame);
				const guarded = GUARDING_HELPERS.has(helper) ? guardsFrom(node, frame) : frame.guarded;
				const atRootScope = frame.atRootScope && !RESCOPING_BLOCKS.has(helper);
				const inner: Frame = { guarded, atRootScope };
				if (node.program?.body) visit(node.program.body, inner);
				if (node.inverse?.body) visit(node.inverse.body, { guarded: frame.guarded, atRootScope });
				continue;
			}

			if (node.type === "PartialStatement" || node.type === "SubExpression") {
				visitArguments(node, frame);
				continue;
			}

			if (node.program?.body) visit(node.program.body, frame);
		}
	}

	visit(ast.body ?? [], { guarded: new Set(), atRootScope: true });

	const required: TemplateVariable[] = [];
	const optional: TemplateVariable[] = [];
	for (const [name, list] of Array.from(sightings).sort(([a], [b]) => a.localeCompare(b))) {
		const paths = Array.from(new Set(list.map(s => s.path))).sort();
		const printed = list.filter(s => s.use === "interpolated");
		const requiredWhen = dedupeGuardSets(printed.map(s => s.guards));
		if (printed.length > 0) required.push({ name, use: "interpolated", paths, requiredWhen });
		else optional.push({ name, use: "conditional", paths, requiredWhen: [] });
	}
	return { required, optional };
}

function dedupeGuardSets(sets: readonly (readonly string[])[]): readonly (readonly string[])[] {
	const normalized = sets.map(set => Array.from(new Set(set)).sort());
	if (normalized.some(set => set.length === 0)) return [[]];
	const seen = new Set<string>();
	const unique: string[][] = [];
	for (const set of normalized) {
		const key = set.join("\x00");
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(set);
	}
	return unique;
}

function isTruthyGuard(value: unknown): boolean {
	if (value === undefined || value === null || value === false) return false;
	if (Array.isArray(value)) return value.length > 0;
	if (value === 0 || value === "") return false;
	return true;
}

export class MissingTemplateVariableError extends Error {
	readonly missing: readonly string[];

	constructor(missing: readonly TemplateVariable[], available: readonly string[], label?: string) {
		const lines = missing.map(variable => {
			const suggestion = closestKey(variable.name, available);
			const paths = variable.paths.length > 1 ? ` (read as ${variable.paths.join(", ")})` : "";
			const hint = suggestion ? ` — did you mean \`${suggestion}\`?` : "";
			return `  \`${variable.name}\`${paths}${hint}`;
		});
		const where = label ? ` in ${label}` : "";
		super(
			`Prompt template${where} interpolates ${missing.length} variable${missing.length === 1 ? "" : "s"} the ` +
				`context does not provide, which would render an empty hole:\n${lines.join("\n")}\n` +
				`Context provides: ${available.length > 0 ? available.map(k => `\`${k}\``).join(", ") : "(nothing)"}.\n` +
				`Fix the caller to pass it, or guard the reference in the template (\`{{#if x}}{{x}}{{/if}}\`) ` +
				`if it is genuinely optional.`,
		);
		this.name = "MissingTemplateVariableError";
		this.missing = missing.map(variable => variable.name);
	}
}

function closestKey(name: string, available: readonly string[]): string | undefined {
	let best: string | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	const limit = Math.max(1, Math.floor(name.length / 3));
	for (const key of available) {
		const distance = levenshteinDistance(name.toLowerCase(), key.toLowerCase());
		if (distance < bestDistance && distance <= limit) {
			best = key;
			bestDistance = distance;
		}
	}
	return best;
}

export function findMissingTemplateVariables(
	template: string,
	context: Record<string, unknown>,
	options: AnalyzeOptions = {},
): readonly TemplateVariable[] {
	const { required } = analyzeTemplate(template, options);
	return required.filter(variable => {
		const value = context[variable.name];
		if (value !== undefined && value !== null) return false;
		return variable.requiredWhen.some(guards => guards.every(guard => isTruthyGuard(context[guard])));
	});
}

export function assertTemplateContext(
	template: string,
	context: Record<string, unknown>,
	label?: string,
	options: AnalyzeOptions = {},
): void {
	const missing = findMissingTemplateVariables(template, context, options);
	if (missing.length > 0) throw new MissingTemplateVariableError(missing, Object.keys(context).sort(), label);
}
