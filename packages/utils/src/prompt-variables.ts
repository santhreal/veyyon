/**
 * Static analysis of what a prompt template requires from its context.
 * Identifies interpolated (required) vs conditional (optional) variables
 * and checks guarded expressions so missing variables fail loudly.
 */
import Handlebars from "handlebars";
import { levenshteinDistance } from "./levenshtein";

/** How a template refers to a name: printed into the output, or only tested. */
export type TemplateVariableUse = "interpolated" | "conditional";

export interface TemplateVariable {
	/** The root name looked up on the context object, e.g. `toolRefs`. */
	readonly name: string;
	readonly use: TemplateVariableUse;
	/** Every full dotted path seen for this root, e.g. `toolRefs.grep`. */
	readonly paths: readonly string[];
	/**
	 * Conditions under which the name is printed, as sets of truthy roots.
	 * Empty array means unconditional.
	 */
	readonly requiredWhen: readonly (readonly string[])[];
}

export interface TemplateVariables {
	/** Interpolated outside any block that tests them. Absent means a hole. */
	readonly required: readonly TemplateVariable[];
	/** Only tested, or interpolated under a guard. Absent means "off". */
	readonly optional: readonly TemplateVariable[];
}

/**
 * Block helpers that evaluate their body against a new context.
 * Bare references inside read iterated items rather than the root context.
 */
const RESCOPING_BLOCKS: ReadonlySet<string> = new Set(["each", "with", "list", "table"]);

/**
 * Helpers whose first path argument guards whatever their body interpolates.
 */
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

/** Path roots that never come from the context object. */
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
	/** Roots that had to be truthy for control flow to reach this reference. */
	guards: readonly string[];
}

/** Walk state: which roots are guarded here, and whether the scope is the root one. */
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

/**
 * Resolves the context root for a path expression, attributing climbs to the root scope.
 */
function contextRoot(path: PathExpressionNode): string | null {
	if (path.data) {
		// @root.foo reaches the root context; @index/@key/@first do not.
		if (path.parts[0] === "root" && path.parts.length > 1) return path.parts[1] ?? null;
		return null;
	}
	const root = path.parts[0];
	if (!root) return null;
	if (BUILTIN_ROOTS.has(root)) return null;
	return root;
}

export interface AnalyzeOptions {
	/**
	 * Helpers registered on the template instance to distinguish helper calls from variables.
	 */
	readonly helperNames?: Iterable<string>;
}

/** Collect every context reference in `template`, classified and scope-aware. */
export function analyzeTemplate(template: string, options: AnalyzeOptions = {}): TemplateVariables {
	const ast = Handlebars.parse(template) as unknown as Node;
	const sightings = new Map<string, Sighting[]>();
	const helperNames = new Set([...Object.keys(Handlebars.helpers), ...(options.helperNames ?? [])]);

	function record(path: PathExpressionNode, use: TemplateVariableUse, frame: Frame): void {
		const root = contextRoot(path);
		if (root === null) return;
		// A reference from inside a rescoped block belongs to the item, not the
		// context, unless it climbed out with `../` or `@root`.
		if (!frame.atRootScope && path.depth === 0 && !path.data) return;
		// A name tested by the very block it sits inside is the author declaring it
		// optional, so it stops being a hole regardless of anything else.
		const effective: TemplateVariableUse = use === "interpolated" && frame.guarded.has(root) ? "conditional" : use;
		const list = sightings.get(root) ?? [];
		list.push({ use: effective, path: path.original, guards: [...frame.guarded] });
		sightings.set(root, list);
	}

	/** Params and hash values are argument positions: tested, never printed. */
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

	/** Every context root named anywhere in a block's arguments, however deep. */
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
		return new Set([...frame.guarded, ...roots]);
	}

	function visit(nodes: readonly Node[], frame: Frame): void {
		for (const node of nodes) {
			if (node.type === "MustacheStatement") {
				const path = node.path;
				if (!path) continue;
				const name = path.parts[0];
				const isHelperCall = (node.params?.length ?? 0) > 0 || (node.hash?.pairs?.length ?? 0) > 0;
				if (isHelperCall || (name !== undefined && helperNames.has(name) && path.parts.length === 1)) {
					// `{{helper a b}}` prints the helper's return value, and its
					// arguments are tested rather than printed.
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
				// The `{{else}}` arm is not covered by the guard: it runs precisely
				// when the tested value was absent.
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
	for (const [name, list] of [...sightings].sort(([a], [b]) => a.localeCompare(b))) {
		const paths = [...new Set(list.map(s => s.path))].sort();
		const printed = list.filter(s => s.use === "interpolated");
		const requiredWhen = dedupeGuardSets(printed.map(s => s.guards));
		if (printed.length > 0) required.push({ name, use: "interpolated", paths, requiredWhen });
		else optional.push({ name, use: "conditional", paths, requiredWhen: [] });
	}
	return { required, optional };
}

/** Collapse guard sets to the distinct ones, dropping any that a weaker one subsumes. */
function dedupeGuardSets(sets: readonly (readonly string[])[]): readonly (readonly string[])[] {
	const normalized = sets.map(set => [...new Set(set)].sort());
	// An unguarded sighting makes every guarded one redundant: the name prints
	// no matter what, so there is nothing left to condition on.
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

/**
 * Tests Handlebars truthiness, where empty arrays are falsy for conditional blocks.
 */
function isTruthyGuard(value: unknown): boolean {
	if (value === undefined || value === null || value === false) return false;
	if (Array.isArray(value)) return value.length > 0;
	if (value === 0 || value === "") return false;
	return true;
}

/**
 * Raised when a template would render an empty hole due to missing required variables.
 */
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

/** The nearest available key, when one is near enough to be worth suggesting. */
function closestKey(name: string, available: readonly string[]): string | undefined {
	let best: string | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	// A third of the name's length, so short names need a near-exact match and
	// long ones tolerate the multi-character slips that make them hard to type.
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

/**
 * Returns required variables that the context fails to supply.
 */
export function findMissingTemplateVariables(
	template: string,
	context: Record<string, unknown>,
	options: AnalyzeOptions = {},
): readonly TemplateVariable[] {
	const { required } = analyzeTemplate(template, options);
	return required.filter(variable => {
		const value = context[variable.name];
		if (value !== undefined && value !== null) return false;
		// Absent, so it is a hole only if control flow can actually reach a place
		// that prints it under THIS context.
		return variable.requiredWhen.some(guards => guards.every(guard => isTruthyGuard(context[guard])));
	});
}

/**
 * Throws MissingTemplateVariableError if context cannot satisfy all required variables.
 */
export function assertTemplateContext(
	template: string,
	context: Record<string, unknown>,
	label?: string,
	options: AnalyzeOptions = {},
): void {
	const missing = findMissingTemplateVariables(template, context, options);
	if (missing.length > 0) throw new MissingTemplateVariableError(missing, Object.keys(context).sort(), label);
}
