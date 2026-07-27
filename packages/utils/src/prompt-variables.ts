/**
 * Static analysis of what a prompt template actually needs from its context.
 *
 * WHY THIS EXISTS. Templates compile with Handlebars `strict: false`, so an
 * unknown or misspelled variable renders as the empty string and nothing
 * complains: `render("dir={{working_dir}}", { workingDir: "/tmp" })` returns
 * `"dir="`. Nothing throws, nothing logs, and no test fails unless one happens
 * to assert the exact bytes. Rename a caller's field, or type `working_dir`
 * where the caller passes `workingDir`, and every user gets a silently shorter
 * prompt — a hole that is invisible in production and impossible to attribute
 * afterwards. That is Law 10 at the prompt layer: a template that cannot be
 * filled has to fail loudly rather than render a gap.
 *
 * WHY NOT JUST `strict: true`. Handlebars' own strict mode throws on any
 * missing path, including the ones that are missing ON PURPOSE. These templates
 * are built out of optional regions — `{{#if secretsEnabled}}`,
 * `{{#has tools "lsp"}}`, `{{#if skills.length}}` — whose whole job is to
 * disappear when the feature is off. Blanket strictness would turn every
 * disabled feature into a crash, so it is not usable here.
 *
 * THE DISTINCTION THAT MAKES THIS WORK is between the two ways a template can
 * name a variable:
 *
 *   - INTERPOLATED, as in `{{toolRefs.grep}}`. The name's value is written into
 *     the output. If it is absent the output has a hole in it, and that is
 *     ALWAYS a bug — there is no reading of `Regex search -> ``` where the
 *     empty backticks were intended.
 *   - CONDITIONAL, as in `{{#if secretsEnabled}}` or `{{default x "none"}}`.
 *     The name is only tested, never printed. Absent means false, which is a
 *     legitimate, designed state.
 *
 * So interpolated references are REQUIRED and conditional ones are OPTIONAL,
 * and that split is derived from the template body rather than declared by
 * hand. Nothing to keep in sync, and it stays correct when a template is
 * edited — which is the same reason the section registry derives its override
 * keys instead of restating them.
 *
 * GUARDING is the third case and the reason a naive version of this would be
 * unusable. `{{#if personality}}{{personality}}{{/if}}` interpolates a name
 * that is explicitly optional; the enclosing conditional is the author saying
 * so. A reference is therefore required only when it is interpolated OUTSIDE
 * any block that tests it. This is what lets the analysis run over the real
 * templates, which are built almost entirely out of guarded regions.
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
	 * Conditions under which the name is actually printed, as sets of other
	 * roots that must all be truthy. Empty array means unconditional.
	 *
	 * `{{#if intentTracing}}{{intentField}}{{/if}}` makes `intentField` required
	 * only when tracing is on, and a check that ignored that would fail every
	 * caller who has the feature switched off — which is most of them. A name
	 * interpolated in several places gets one entry per place, and satisfying
	 * ANY of them makes it required, because any one of them can render.
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
 * Block helpers that evaluate their body against a NEW context.
 *
 * Inside these, a bare `{{name}}` reads a field of the item being iterated, not
 * of the root context, so attributing it to the root would invent a required
 * variable that no caller could ever satisfy. Kept in step with the helper
 * definitions in `prompt.ts`: each of these calls `options.fn(item)` with
 * something other than `this`.
 */
const RESCOPING_BLOCKS: ReadonlySet<string> = new Set(["each", "with", "list", "table"]);

/**
 * Helpers whose FIRST path argument guards whatever their body interpolates.
 *
 * `unless` is deliberately absent: its body runs when the argument is falsy, so
 * a name interpolated inside is not protected by the test above it — if
 * anything it is the opposite.
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
 * The context root a path expression reads, or null when it reads something
 * that is not the context (a literal, a builtin, an `@data` variable).
 *
 * `depth` counts `../` hops. A path that climbs out of the current scope is
 * reaching for an outer context, and since only the root scope is tracked
 * precisely, any climb is attributed to the root — the conservative direction,
 * because a missed attribution loses a check while a wrong one invents a
 * requirement that fails the build.
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
	 * Names registered as helpers on the instance that will render this template.
	 *
	 * Required rather than read off the global Handlebars, because `prompt.ts`
	 * renders on a PRIVATE instance (`Handlebars.create()`) carrying ~20 helpers
	 * the global does not have. Reading the wrong registry would misread a
	 * zero-argument helper mustache as a context variable and demand a caller
	 * supply it.
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
 * Handlebars' own notion of truth, which is what the guard actually tested.
 *
 * It differs from JavaScript's in the case that matters most here: an EMPTY
 * ARRAY is falsy to `{{#if}}`, and the templates lean on that constantly
 * (`{{#if skills.length}}`, `{{#if toolInfo.length}}`). Using `!!value` would
 * treat "no skills" as "skills present" and demand a variable that the block
 * will never reach.
 */
function isTruthyGuard(value: unknown): boolean {
	if (value === undefined || value === null || value === false) return false;
	if (Array.isArray(value)) return value.length > 0;
	if (value === 0 || value === "") return false;
	return true;
}

/**
 * Raised when a template would render a hole.
 *
 * Carries the variable, the exact paths the template reads through it, and the
 * closest context key by edit distance, because the overwhelmingly common cause
 * is a rename or a typo and the fix is then obvious from the message alone.
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
 * Every required variable of `template` that `context` fails to supply.
 *
 * `null` counts as missing alongside `undefined`: both render as the empty
 * string, so both leave the same hole, and a check that accepted `null` would
 * pass on exactly the case where an upstream lookup returned nothing.
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
 * Throw unless `context` can fill every hole `template` would otherwise leave.
 *
 * `label` names the template in the message; pass the file path when there is
 * one, since a stack trace through the render machinery does not say which of
 * 143 templates failed.
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
