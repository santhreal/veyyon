import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	errorMessage,
	isEnoent,
	isRecord,
	logger,
	quarantineUnparseableFile,
	syncYamlTextToSettings,
} from "@veyyon/utils";
import { type } from "arktype";
import { YAML } from "bun";
import { expandAtImports } from "../discovery/at-imports";
import { BUILTIN_TOOL_NAMES, normalizeToolNames } from "../tools/builtin-names";
import { collectConfigCandidates } from "./watchdog";

export interface AdvisorConfig {
	name: string;
	model?: string;
	tools?: string[];
	instructions?: string;
}

export interface DiscoveredAdvisors {
	advisors: AdvisorConfig[];
	sharedInstructions: string | undefined;
}

const advisorEntrySchema = type({
	name: "string",
	"model?": "string",
	"tools?": "string[]",
	"instructions?": "string",
});

const watchdogYamlSchema = type({
	"instructions?": "string",
	"advisors?": advisorEntrySchema.array(),
});

export function slugifyAdvisorName(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "advisor";
}

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADVISOR_PROVIDER_SESSION_KEY_SEPARATOR = "\u0000";

export function getOrCreateAdvisorProviderSessionId(
	ids: Map<string, string>,
	primarySessionId: string | undefined,
	slug: string,
	randomSessionId: () => string = () => Bun.randomUUIDv7(),
): string | undefined {
	if (!primarySessionId) return undefined;
	const key = `${primarySessionId}${ADVISOR_PROVIDER_SESSION_KEY_SEPARATOR}${slug}`;
	const existing = ids.get(key);
	if (existing) return existing;

	const next = randomSessionId();
	if (!UUID_V7_PATTERN.test(next)) {
		throw new Error("Advisor provider session id generator returned a non-UUIDv7 value");
	}
	ids.set(key, next);
	return next;
}

const KNOWN_TOOL_NAMES = new Set<string>(BUILTIN_TOOL_NAMES);

function filterAdvisorTools(tools: string[] | undefined, sourcePath: string): string[] | undefined {
	if (tools === undefined) return undefined;
	if (tools.length === 0) return [];
	const filtered = normalizeToolNames(tools).filter(name => {
		if (KNOWN_TOOL_NAMES.has(name)) return true;
		logger.warn("Advisor config: dropping unknown tool", { path: sourcePath, tool: name });
		return false;
	});
	return filtered.length > 0 ? filtered : undefined;
}

export async function discoverAdvisorConfigs(cwd: string, agentDir?: string): Promise<DiscoveredAdvisors> {
	const items = await collectConfigCandidates(cwd, agentDir, ["WATCHDOG.yml", "WATCHDOG.yaml"]);
	const advisors = new Map<string, AdvisorConfig>();
	const sharedParts: string[] = [];

	for (const item of items) {
		let parsed: unknown;
		try {
			parsed = YAML.parse(item.content);
		} catch (err) {
			logger.warn("Advisor config: failed to parse YAML", { path: item.path, error: errorMessage(err) });
			continue;
		}
		if (!isRecord(parsed)) {
			logger.warn("Advisor config: expected a YAML mapping", { path: item.path });
			continue;
		}
		const result = watchdogYamlSchema(parsed);
		if (result instanceof type.errors) {
			logger.warn("Advisor config: invalid schema", { path: item.path, error: result.summary });
			continue;
		}

		if (result.instructions?.trim()) {
			const expanded = (await expandAtImports(result.instructions, item.path)).trim();
			if (expanded) sharedParts.push(expanded);
		}

		for (const entry of result.advisors ?? []) {
			const slug = slugifyAdvisorName(entry.name);
			const instructions = entry.instructions?.trim()
				? (await expandAtImports(entry.instructions, item.path)).trim() || undefined
				: undefined;
			advisors.set(slug, {
				name: entry.name,
				model: entry.model?.trim() || undefined,
				tools: filterAdvisorTools(entry.tools, item.path),
				instructions,
			});
		}
	}

	return {
		advisors: Array.from(advisors.values()),
		sharedInstructions: sharedParts.length > 0 ? sharedParts.join("\n\n") : undefined,
	};
}

export type AdvisorConfigScope = "project" | "user";

export interface WatchdogConfigDoc {
	instructions?: string;
	advisors: AdvisorConfig[];
}

export function advisorConfigFilePath(
	scope: AdvisorConfigScope,
	dirs: { projectDir: string; agentDir: string },
): string {
	return path.join(scope === "user" ? dirs.agentDir : dirs.projectDir, "WATCHDOG.yml");
}

export async function resolveAdvisorConfigEditPath(
	scope: AdvisorConfigScope,
	dirs: { projectDir: string; agentDir: string },
): Promise<string> {
	const dir = scope === "user" ? dirs.agentDir : dirs.projectDir;
	const yml = path.join(dir, "WATCHDOG.yml");
	const yaml = path.join(dir, "WATCHDOG.yaml");
	if (!(await Bun.file(yml).exists()) && (await Bun.file(yaml).exists())) return yaml;
	return yml;
}

export async function loadWatchdogConfigFile(filePath: string): Promise<WatchdogConfigDoc> {
	let text: string;
	try {
		text = await Bun.file(filePath).text();
	} catch (err) {
		if (!isEnoent(err))
			logger.warn("Advisor config: failed to read for edit", { path: filePath, error: errorMessage(err) });
		return { advisors: [] };
	}
	let parsed: unknown;
	try {
		parsed = YAML.parse(text);
	} catch (err) {
		await quarantineUnparseableFile(filePath, text, err);
		return { advisors: [] };
	}
	if (!isRecord(parsed)) {
		await quarantineUnparseableFile(filePath, text, new Error("expected a YAML mapping"));
		return { advisors: [] };
	}
	const result = watchdogYamlSchema(parsed);
	if (result instanceof type.errors) {
		await quarantineUnparseableFile(filePath, text, new Error(result.summary));
		return { advisors: [] };
	}
	return {
		instructions: result.instructions?.trim() ? result.instructions : undefined,
		advisors: (result.advisors ?? []).map(a => ({
			name: a.name,
			model: a.model?.trim() || undefined,
			tools: a.tools === undefined ? undefined : Array.from(a.tools),
			instructions: a.instructions?.trim() ? a.instructions : undefined,
		})),
	};
}

export function serializeWatchdogConfig(doc: WatchdogConfigDoc): string {
	const out: { instructions?: string; advisors?: AdvisorConfig[] } = {};
	if (doc.instructions?.trim()) out.instructions = doc.instructions;
	if (doc.advisors.length > 0) {
		out.advisors = doc.advisors.map(a => {
			const entry: AdvisorConfig = { name: a.name };
			if (a.model?.trim()) entry.model = a.model;
			if (a.tools !== undefined) entry.tools = Array.from(a.tools);
			if (a.instructions?.trim()) entry.instructions = a.instructions;
			return entry;
		});
	}
	if (out.instructions === undefined && out.advisors === undefined) return "";
	const text = YAML.stringify(out, null, 2);
	return text.endsWith("\n") ? text : `${text}\n`;
}

export async function saveWatchdogConfigFile(filePath: string, doc: WatchdogConfigDoc): Promise<void> {
	const content = serializeWatchdogConfig(doc);
	if (!content.trim()) {
		try {
			await fs.rm(filePath, { force: true });
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		return;
	}
	let existingText = "";
	try {
		existingText = await Bun.file(filePath).text();
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
	let edited: string;
	try {
		edited = syncYamlTextToSettings(existingText, YAML.parse(content) as Record<string, unknown>);
	} catch (err) {
		throw new Error(
			`Cannot save ${filePath}: its current contents cannot be edited in place (${errorMessage(err)}). ` +
				"Fix the file, or move it aside and save again.",
			{ cause: err },
		);
	}
	await Bun.write(filePath, edited);
}
