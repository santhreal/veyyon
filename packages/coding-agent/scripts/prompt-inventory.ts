import * as path from "node:path";
import { agentCorePrompts } from "@veyyon/agent-core/prompts/registry";
import { aiPrompts } from "@veyyon/ai/prompts/registry";
import { hashlinePrompts } from "@veyyon/hashline/prompts/registry";
import { prompt } from "@veyyon/utils";
import { editBenchmarkPrompts } from "../../metaharness/adapters/edit/prompts/registry";
import { codingAgentPrompts } from "../src/prompts/registry";

const PROMPT_DIRS = [codingAgentPrompts, agentCorePrompts, aiPrompts, hashlinePrompts, editBenchmarkPrompts].map(
	registry => registry.dir,
);

const SOURCE_ROOTS = ["packages"] as const;

const EXCLUDED = ["node_modules", "deepswe-bench/repo-cache", "dist", ".git"];

export interface PromptTemplateEntry {
	readonly file: string;
	readonly renderers: readonly string[];
	readonly required: readonly string[];
	readonly optional: readonly string[];
	readonly bytes: number;
}

export interface PromptInventory {
	readonly templates: readonly PromptTemplateEntry[];
	readonly orphans: readonly string[];
	readonly testOnly: readonly string[];
	readonly danglingReferences: readonly { readonly from: string; readonly to: string }[];
}

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

const MD_IMPORT = /from\s+"([^"]+\.md)"/g;

function rowTableNames(): string[] {
	const directories = new Set(codingAgentPrompts.ids.map(id => id.split("/")[0] as string));
	return [...directories]
		.sort()
		.map(directory => `${directory.replace(/-(\w)/g, (_all, letter: string) => letter.toUpperCase())}Prompts`);
}

export const REGISTRY_LOOKUP = new RegExp(
	`\\b(?:(?:[A-Z][A-Z_]*_)?PROMPTS|${rowTableNames().join("|")})\\[\\s*"([^"]+)"\\s*\\]`,
	"g",
);

const PROMPT_DIRS_BY_DEPTH = [...PROMPT_DIRS].sort((a, b) => b.length - a.length);

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
				record(file ?? path.join(PROMPT_DIRS[0], `${match[1]}.md`), source);
			}

			if (!text.includes('.md"')) continue;
			for (const match of text.matchAll(MD_IMPORT)) {
				const specifier = match[1] as string;
				if (!specifier.startsWith(".")) continue;
				const target = path.normalize(path.join(path.dirname(source), specifier));
				record(path.relative(repoRoot, target), source);
			}
		}
	}
	return byTemplate;
}

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
		if (!PROMPT_DIRS.some(dir => target.startsWith(dir))) continue;
		for (const source of sources) danglingReferences.push({ from: source, to: target });
	}
	danglingReferences.sort((a, b) => a.to.localeCompare(b.to));

	return { templates, orphans, testOnly, danglingReferences };
}

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
