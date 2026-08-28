import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, isRecord, logger, removeTempPath, scopedTimeoutSignal } from "@veyyon/utils";
import * as git from "../../../utils/git";

import type { MarketplaceCatalog, MarketplaceSourceType } from "./types";
import { isValidNameSegment } from "./types";

export interface FetchResult {
	catalog: MarketplaceCatalog;
	clonePath?: string;
}

const WIN_ABS_RE = /^[A-Za-z]:[/\\]|^\\\\/;

const GITHUB_SHORTHAND_RE = /^[a-z0-9-]+\/[a-z0-9._-]+$/i;

export function classifySource(source: string): MarketplaceSourceType {
	if (source.startsWith("https://") || source.startsWith("http://")) {
		try {
			const { pathname } = new URL(source);
			return pathname.endsWith(".json") ? "url" : "git";
		} catch {
			return "git";
		}
	}

	if (source.startsWith("git@") || source.startsWith("ssh://")) {
		return "git";
	}

	if (GITHUB_SHORTHAND_RE.test(source)) {
		return "github";
	}

	if (source.startsWith("./") || source.startsWith("~/")) {
		return "local";
	}

	if (path.isAbsolute(source) || WIN_ABS_RE.test(source)) {
		return "local";
	}

	throw new Error(`Unrecognized source format. Did you mean './${source}' (local) or 'owner/repo' (GitHub)?`);
}

function assertField(condition: boolean, field: string, filePath: string): void {
	if (!condition) {
		throw new Error(`Missing or invalid field "${field}" in catalog: ${filePath}`);
	}
}

export function parseMarketplaceCatalog(content: string, filePath: string): MarketplaceCatalog {
	let raw: unknown;
	try {
		raw = JSON.parse(content);
	} catch (err) {
		throw new Error(`Failed to parse marketplace catalog at ${filePath}: ${(err as Error).message}`);
	}

	if (!isRecord(raw)) {
		throw new Error(`Marketplace catalog at ${filePath} must be a JSON object`);
	}

	const obj = raw as Record<string, unknown>;

	assertField(typeof obj.name === "string" && isValidNameSegment(obj.name), "name", filePath);

	assertField(isRecord(obj.owner), "owner", filePath);
	const owner = obj.owner as Record<string, unknown>;
	assertField(typeof owner.name === "string", "owner.name", filePath);

	assertField(Array.isArray(obj.plugins), "plugins", filePath);

	const plugins = obj.plugins as unknown[];
	const validPlugins: unknown[] = [];
	for (let i = 0; i < plugins.length; i++) {
		try {
			const entry = plugins[i];
			assertField(isRecord(entry), `plugins[${i}]`, filePath);
			const p = entry as Record<string, unknown>;
			assertField(typeof p.name === "string" && isValidNameSegment(p.name), `plugins[${i}].name`, filePath);
			assertField(
				typeof p.source === "string" ||
					(typeof p.source === "object" &&
						p.source !== null &&
						!Array.isArray(p.source) &&
						typeof (p.source as Record<string, unknown>).source === "string"),
				`plugins[${i}].source`,
				filePath,
			);
			if (typeof p.source === "string") {
				assertField((p.source as string).startsWith("./"), `plugins[${i}].source (must start with "./")`, filePath);
			}
			if (typeof p.source === "object" && p.source !== null) {
				const src = p.source as Record<string, unknown>;
				const variant = src.source as string;
				if (variant === "github") {
					assertField(typeof src.repo === "string" && src.repo.length > 0, `plugins[${i}].source.repo`, filePath);
				} else if (variant === "url" || variant === "git-subdir") {
					assertField(typeof src.url === "string" && src.url.length > 0, `plugins[${i}].source.url`, filePath);
					if (variant === "git-subdir") {
						assertField(
							typeof src.path === "string" && src.path.length > 0,
							`plugins[${i}].source.path`,
							filePath,
						);
					}
				} else if (variant === "npm") {
					assertField(
						typeof src.package === "string" && src.package.length > 0,
						`plugins[${i}].source.package`,
						filePath,
					);
				} else {
					assertField(false, `plugins[${i}].source.source (unknown variant: "${variant}")`, filePath);
				}
			}
			validPlugins.push(entry);
		} catch (err) {
			const name =
				typeof plugins[i] === "object" && plugins[i] !== null
					? ((plugins[i] as Record<string, unknown>).name ?? `[${i}]`)
					: `[${i}]`;
			logger.warn(`Skipping invalid plugin ${name}: ${(err as Error).message}`);
		}
	}
	obj.plugins = validPlugins;

	return obj as unknown as MarketplaceCatalog;
}

const CATALOG_RELATIVE_PATHS: readonly string[] = [
	".veyyon-plugin/marketplace.json",
	".claude-plugin/marketplace.json",
];

async function readMarketplaceCatalog(
	root: string,
	options: { relativeDisplayPaths?: boolean } = {},
): Promise<{ catalogPath: string; displayPath: string; content: string }> {
	const tried: string[] = [];
	for (const rel of CATALOG_RELATIVE_PATHS) {
		const catalogPath = path.join(root, ...rel.split("/"));
		const displayPath = options.relativeDisplayPaths ? rel : catalogPath;
		tried.push(displayPath);
		try {
			const content = await Bun.file(catalogPath).text();
			return { catalogPath, displayPath, content };
		} catch (err) {
			if (isEnoent(err)) continue;
			throw err;
		}
	}
	throw new Error(
		`Marketplace catalog not found at ${tried.map(p => `"${p}"`).join(" or ")}. ` +
			`Ensure the directory exists and contains one of: ${CATALOG_RELATIVE_PATHS.join(", ")}.`,
	);
}

function expandHome(p: string): string {
	if (p.startsWith("~/")) {
		return path.join(os.homedir(), p.slice(2));
	}
	return p;
}

export async function fetchMarketplace(source: string, cacheDir: string): Promise<FetchResult> {
	const type = classifySource(source);

	if (type === "local") {
		const resolved = path.resolve(expandHome(source));
		const { catalogPath, content } = await readMarketplaceCatalog(resolved);
		const catalog = parseMarketplaceCatalog(content, catalogPath);
		return { catalog };
	}

	if (type === "github") {
		const url = `https://github.com/${source}.git`;
		return cloneAndReadCatalog(url, source, cacheDir);
	}

	if (type === "git") {
		return cloneAndReadCatalog(source, source, cacheDir);
	}

	const { signal, cancel } = scopedTimeoutSignal(60_000);
	let text: string;
	try {
		const response = await fetch(source, { signal });
		if (!response.ok) {
			throw new Error(
				`Failed to fetch marketplace catalog from ${source}: HTTP ${response.status} ${response.statusText}`,
			);
		}
		text = await response.text();
	} finally {
		cancel();
	}
	const catalog = parseMarketplaceCatalog(text, source);

	const catalogDir = path.join(cacheDir, catalog.name);
	await Bun.write(path.join(catalogDir, "marketplace.json"), text);

	return { catalog };
}

async function cloneAndReadCatalog(url: string, source: string, cacheDir: string): Promise<FetchResult> {
	const tmpDir = path.join(cacheDir, `.tmp-clone-${Date.now()}`);
	await fs.mkdir(cacheDir, { recursive: true });

	logger.debug(`[marketplace] cloning ${url} → ${tmpDir}`);
	await git.clone(url, tmpDir);

	try {
		const { displayPath, content } = await readMarketplaceCatalog(tmpDir, { relativeDisplayPaths: true });
		const catalog = parseMarketplaceCatalog(content, displayPath);
		return { catalog, clonePath: tmpDir };
	} catch (err) {
		await removeTempPath(tmpDir, "marketplace-catalog-unreadable");
		throw new Error(`Cloned repository ${url}: ${(err as Error).message} (source: ${source})`, { cause: err });
	}
}

export async function promoteCloneToCache(tmpDir: string, cacheDir: string, name: string): Promise<string> {
	const finalDir = path.join(cacheDir, name);
	await fs.rm(finalDir, { recursive: true, force: true });
	await fs.rename(tmpDir, finalDir);
	return finalDir;
}
