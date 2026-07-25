/**
 * The inventory of every prompt template in the repository, generated.
 *
 * WHY THIS EXISTS. There are 175 prompt files across five directories and 105
 * modules that import one. Every file is referenced by something, but nothing
 * stated what the SET was: which prompt a given file contributes to, what
 * renders it, what variables it takes, or whether it is live on the default
 * path at all. The section registry is self-describing for its nine sections;
 * the other ~160 files were discoverable only by grep.
 *
 * That is not just an ergonomics problem. It is what made the missing-variable
 * class of defect (SYSPROMPT-1) hard to reason about: you cannot check a
 * variable rename against callers you cannot enumerate.
 *
 * GENERATED, NEVER HAND-MAINTAINED. The inventory is derived from two facts on
 * disk — which `.md` files exist under a `prompts/` directory, and which
 * modules import them — joined with the variable contract the analyzer reads
 * out of each template. A hand-written list would be wrong within a week and
 * would then be worse than nothing, because it would look authoritative.
 *
 * Run it directly to print the inventory:
 *
 *     bun packages/coding-agent/scripts/prompt-inventory.ts
 *     bun packages/coding-agent/scripts/prompt-inventory.ts --json
 *
 * `prompt-inventory.test.ts` asserts the two invariants it makes checkable: no
 * template exists without a module that renders it, and no module imports a
 * template that is not there.
 */
import * as path from "node:path";
import { prompt } from "@veyyon/utils";

/**
 * Directories holding prompt templates, relative to the repository root.
 *
 * One per package that owns prompts, each with a `registry.ts` beside it that
 * imports every file in the tree. This list used to name five directories
 * because prompts lived wherever their consumer did (`src/commit/prompts`,
 * `src/commit/agentic/prompts`, `src/compaction/prompts`, and so on), which is
 * the same scatter that let 120 of 143 prompts go unregistered. They now live in
 * their package's one prompts tree, so this list shrinks as prompts consolidate
 * rather than growing as they spread.
 */
const PROMPT_DIRS = [
	"packages/coding-agent/src/prompts",
	"packages/agent/src/prompts",
	"packages/metaharness/adapters/edit/prompts",
] as const;

/** Roots scanned for modules that import a template. */
const SOURCE_ROOTS = ["packages"] as const;

/** Directories that are vendored or cached corpora, never our own prompts. */
const EXCLUDED = ["node_modules", "deepswe-bench/repo-cache", "dist", ".git"];

export interface PromptTemplateEntry {
	/** Repository-relative path of the `.md` file. */
	readonly file: string;
	/** Modules that import it, repository-relative, sorted. */
	readonly renderers: readonly string[];
	/** Names the template prints, which a renderer MUST supply. */
	readonly required: readonly string[];
	/** Names it only tests, which may legitimately be absent. */
	readonly optional: readonly string[];
	readonly bytes: number;
}

export interface PromptInventory {
	readonly templates: readonly PromptTemplateEntry[];
	/** Templates no module imports: dead files, or a broken wiring. */
	readonly orphans: readonly string[];
	/**
	 * Templates only a TEST imports.
	 *
	 * Not an orphan by the file-reference check, and dead in production all the
	 * same: nothing on a real path renders it, so it ships as bytes nobody sends.
	 * Worth naming separately because the fix differs — an orphan is deleted or
	 * wired up, whereas this is usually a production caller that was removed and
	 * left its test behind.
	 */
	readonly testOnly: readonly string[];
	/** Imports pointing at a file that does not exist. */
	readonly danglingReferences: readonly { readonly from: string; readonly to: string }[];
}

/** A module under a `test/` directory or named `*.test.ts`. */
function isTestModule(file: string): boolean {
	return file.includes("/test/") || file.endsWith(".test.ts");
}

function isExcluded(file: string): boolean {
	return EXCLUDED.some(fragment => file.includes(fragment));
}

async function listFiles(root: string, extension: string): Promise<string[]> {
	const glob = new Bun.Glob(`**/*${extension}`);
	const out: string[] = [];
	for await (const relative of glob.scan({ cwd: root, onlyFiles: true })) {
		const file = path.join(root, relative);
		if (!isExcluded(file)) out.push(file);
	}
	return out;
}

/** Every `from "....md"` specifier in a source file, with its resolved target. */
const MD_IMPORT = /from\s+"([^"]+\.md)"/g;

/**
 * A registry lookup: `PROMPTS["turn-control/auto-continue"]`, in either package.
 *
 * This is what a renderer looks like now. Every prompt is imported exactly once,
 * by its package's `registry.ts`, so following `.md` imports would report the
 * registry as the sole renderer of all 176 prompts and tell you nothing. The
 * useful question, "which module actually uses this prompt", is answered by the
 * id, and the id is the file's path under its prompts directory, so a lookup
 * resolves back to a file without a second table.
 */
const REGISTRY_LOOKUP = /\b(?:PROMPTS|AGENT_PROMPTS)\[\s*"([^"]+)"\s*\]/g;

/** Prompts directories keyed for id resolution, longest first so nesting is safe. */
const PROMPT_DIRS_BY_DEPTH = [...PROMPT_DIRS].sort((a, b) => b.length - a.length);

/** Resolve a registry id to the template file it names, in whichever tree holds it. */
function templateFileForId(repoRoot: string, id: string): string | undefined {
	for (const dir of PROMPT_DIRS_BY_DEPTH) {
		const candidate = path.join(dir, `${id}.md`);
		if (Bun.file(path.join(repoRoot, candidate)).size > 0) return candidate;
	}
	return undefined;
}

async function collectRenderers(repoRoot: string): Promise<Map<string, Set<string>>> {
	const byTemplate = new Map<string, Set<string>>();
	const record = (templateKey: string, source: string): void => {
		const renderers = byTemplate.get(templateKey) ?? new Set();
		renderers.add(path.relative(repoRoot, source));
		byTemplate.set(templateKey, renderers);
	};

	for (const root of SOURCE_ROOTS) {
		for (const source of await listFiles(path.join(repoRoot, root), ".ts")) {
			const text = await Bun.file(source).text();

			for (const match of text.matchAll(REGISTRY_LOOKUP)) {
				const file = templateFileForId(repoRoot, match[1] as string);
				// An id naming no file is reported through danglingReferences below,
				// keyed by the path it would have had, so the message names a file.
				record(file ?? path.join(PROMPT_DIRS[0], `${match[1]}.md`), source);
			}

			// Direct `.md` imports still count, so a package that has not adopted a
			// registry yet (metaharness) is not reported as having zero renderers.
			if (!text.includes('.md"')) continue;
			for (const match of text.matchAll(MD_IMPORT)) {
				const specifier = match[1] as string;
				// Only relative specifiers can be resolved to a file on disk; a
				// package specifier is another package's concern.
				if (!specifier.startsWith(".")) continue;
				const target = path.normalize(path.join(path.dirname(source), specifier));
				record(path.relative(repoRoot, target), source);
			}
		}
	}
	return byTemplate;
}

/** Build the inventory by joining the files on disk with the imports of them. */
export async function buildPromptInventory(repoRoot: string): Promise<PromptInventory> {
	const renderersByTemplate = await collectRenderers(repoRoot);

	const templateFiles: string[] = [];
	for (const dir of PROMPT_DIRS) {
		for (const file of await listFiles(path.join(repoRoot, dir), ".md")) {
			templateFiles.push(path.relative(repoRoot, file));
		}
	}
	templateFiles.sort();

	const templates: PromptTemplateEntry[] = [];
	const orphans: string[] = [];
	const testOnly: string[] = [];
	for (const file of templateFiles) {
		const renderers = [...(renderersByTemplate.get(file) ?? [])].sort();
		if (renderers.length === 0) orphans.push(file);
		else if (renderers.every(isTestModule)) testOnly.push(file);
		const text = await Bun.file(path.join(repoRoot, file)).text();
		const analysis = prompt.analyzePromptTemplate(text);
		templates.push({
			file,
			renderers,
			required: analysis.required.map(v => v.name),
			optional: analysis.optional.map(v => v.name),
			bytes: Buffer.byteLength(text, "utf8"),
		});
	}

	const known = new Set(templateFiles);
	const danglingReferences: { from: string; to: string }[] = [];
	for (const [target, sources] of renderersByTemplate) {
		if (known.has(target)) continue;
		// Only a target inside a prompts directory is this inventory's business;
		// a README or a fixture imported as text is not a prompt.
		if (!PROMPT_DIRS.some(dir => target.startsWith(dir))) continue;
		for (const source of sources) danglingReferences.push({ from: source, to: target });
	}
	danglingReferences.sort((a, b) => a.to.localeCompare(b.to));

	return { templates, orphans, testOnly, danglingReferences };
}

/** The inventory as a table, grouped by directory. */
export function formatInventory(inventory: PromptInventory): string {
	const lines: string[] = [];
	let currentDir = "";
	for (const entry of inventory.templates) {
		const dir = path.dirname(entry.file);
		if (dir !== currentDir) {
			lines.push("", `## ${dir}`, "");
			currentDir = dir;
		}
		const name = path.basename(entry.file);
		const vars = entry.required.length > 0 ? `requires ${entry.required.join(", ")}` : "no required variables";
		const optional = entry.optional.length > 0 ? `; optional ${entry.optional.join(", ")}` : "";
		lines.push(`- ${name} (${entry.bytes} bytes) — ${vars}${optional}`);
		for (const renderer of entry.renderers) lines.push(`    rendered by ${renderer}`);
		if (entry.renderers.length === 0) lines.push("    ORPHAN: no module imports this file");
	}
	lines.push(
		"",
		`${inventory.templates.length} templates, ${inventory.orphans.length} orphans, ` +
			`${inventory.testOnly.length} rendered only by tests.`,
	);
	return lines.join("\n").trimStart();
}

if (import.meta.main) {
	const repoRoot = path.resolve(import.meta.dir, "../../..");
	const inventory = await buildPromptInventory(repoRoot);
	console.log(process.argv.includes("--json") ? JSON.stringify(inventory, null, 2) : formatInventory(inventory));
}
