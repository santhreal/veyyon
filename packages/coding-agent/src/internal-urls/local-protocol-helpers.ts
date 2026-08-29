import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { formatBytes, formatCount } from "@veyyon/utils/format";
import { isEnoent } from "@veyyon/utils/fs-error";
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import { getContentType } from "./content-type";
import { ensureWithinRoot as ensureWithinRootShared } from "./filesystem-resource";
import { parseInternalUrl } from "./parse";
import { validateRelativePath } from "./relative-path";
import type { InternalResource, InternalUrl } from "./types";

export interface LocalProtocolOptions {
	getArtifactsDir?: () => string | null;
	getSessionId?: () => string | null;
}

export function parseLocalUrl(input: string): InternalUrl {
	return parseInternalUrl(input);
}

export function ensureWithinRoot(targetPath: string, rootPath: string): void {
	ensureWithinRootShared(targetPath, rootPath, "local");
}

export function toLocalValidationError(error: unknown): Error {
	const message = errorMessage(error);
	return new Error(message.replace("skill://", "local://"));
}
export const WINDOWS_LOCAL_ROOT_MAX_CHARS = 180;

export function safeSessionId(options: LocalProtocolOptions): string {
	const raw = options.getSessionId?.() ?? "session";
	const safe = raw.replace(/[^a-zA-Z0-9_.-]/g, "_");
	return safe.length > 0 ? safe : "session";
}

export function shortLocalRoot(options: LocalProtocolOptions): string {
	return path.join(os.tmpdir(), "veyyon-local", safeSessionId(options));
}

export const LOCAL_TEXT_SNIFF_BYTES = 8 * 1024;
export const LOCAL_TEXT_RESOURCE_MAX_BYTES = 1024 * 1024;
export const BINARY_FILE_EXTENSIONS = new Set([
	".7z",
	".avi",
	".bmp",
	".bz2",
	".db",
	".doc",
	".docx",
	".gif",
	".gz",
	".ico",
	".jpeg",
	".jpg",
	".m4v",
	".mkv",
	".mov",
	".mp4",
	".pdf",
	".png",
	".ppt",
	".pptx",
	".rar",
	".sqlite",
	".tgz",
	".webm",
	".webp",
	".wmv",
	".xls",
	".xlsx",
	".xz",
	".zip",
]);

export function buildNonTextLocalResource(
	url: InternalUrl,
	filePath: string,
	size: number,
	reason: string,
): InternalResource {
	const content = `[Cannot read binary local:// file '${url.href}' (${formatBytes(size)}): ${reason}. This resource is not text. Use a metadata/key-frame/video-specific workflow instead.]`;
	return {
		url: url.href,
		content,
		contentType: "text/plain",
		size: Buffer.byteLength(content, "utf-8"),
		sourcePath: filePath,
		notes: [LOCAL_WRITE_NOTE],
	};
}

export function buildLargeLocalTextResource(url: InternalUrl, filePath: string, size: number): InternalResource {
	const content = `[Cannot materialize local:// file '${url.href}' as an internal text resource (${formatBytes(size)} exceeds ${formatBytes(LOCAL_TEXT_RESOURCE_MAX_BYTES)}). Use the read tool's filesystem path handling or a line selector so content is streamed with file-size safeguards.]`;
	return {
		url: url.href,
		content,
		contentType: "text/plain",
		size: Buffer.byteLength(content, "utf-8"),
		sourcePath: filePath,
		notes: [LOCAL_WRITE_NOTE],
	};
}

export async function readFilePrefix(filePath: string, maxBytes: number): Promise<Uint8Array> {
	if (maxBytes <= 0) return new Uint8Array();
	const handle = await fs.open(filePath, "r");
	try {
		const buffer = Buffer.allocUnsafe(maxBytes);
		const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

export function isUtf8Text(bytes: Uint8Array): boolean {
	if (bytes.indexOf(0) !== -1) return false;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return true;
	} catch {
		return false;
	}
}

export async function buildFileResource(
	url: InternalUrl,
	resolved: Extract<ResolvedLocalTarget, { kind: "file" }>,
): Promise<InternalResource> {
	if (BINARY_FILE_EXTENSIONS.has(path.extname(resolved.path).toLowerCase())) {
		return buildNonTextLocalResource(url, resolved.path, resolved.size, "extension is a known binary/container type");
	}
	const sniffBytes = await readFilePrefix(resolved.path, Math.min(resolved.size, LOCAL_TEXT_SNIFF_BYTES));
	if (!isUtf8Text(sniffBytes)) {
		return buildNonTextLocalResource(url, resolved.path, resolved.size, "content is not valid UTF-8 text");
	}
	if (resolved.size > LOCAL_TEXT_RESOURCE_MAX_BYTES) {
		return buildLargeLocalTextResource(url, resolved.path, resolved.size);
	}
	const content = await Bun.file(resolved.path).text();
	return {
		url: url.href,
		content,
		contentType: getContentType(resolved.path),
		size: Buffer.byteLength(content, "utf-8"),
		sourcePath: resolved.path,
		notes: [LOCAL_WRITE_NOTE],
	};
}

export async function listFilesRecursively(rootPath: string): Promise<string[]> {
	const pending = [""];
	const files: string[] = [];

	while (pending.length > 0) {
		const relativeDir = pending.pop();
		if (relativeDir === undefined) continue;
		const absoluteDir = path.join(rootPath, relativeDir);
		const entries = await fs.readdir(absoluteDir, { withFileTypes: true });

		for (const entry of entries) {
			const entryPath = path.join(relativeDir, entry.name);
			if (entry.isDirectory()) {
				pending.push(entryPath);
				continue;
			}
			if (entry.isFile()) {
				files.push(entryPath.replaceAll(path.sep, "/"));
			}
		}
	}

	return files.sort((a, b) => a.localeCompare(b));
}

export async function buildListing(url: InternalUrl, localRoot: string): Promise<InternalResource> {
	const files = await listFilesRecursively(localRoot);
	const listing = files.length === 0 ? "(empty)" : files.map(file => `- [${file}](local://${file})`).join("\n");
	const content =
		`# Local\n\n` +
		`Session-scoped scratch space for large intermediate data, subagent handoffs, and reusable planning artifacts.\n\n` +
		`Root: ${localRoot}\n\n` +
		`${formatCount("file", files.length)} available:\n\n` +
		`${listing}\n`;

	return {
		url: url.href,
		content,
		contentType: "text/markdown",
		size: Buffer.byteLength(content, "utf-8"),
		sourcePath: localRoot,
	};
}

export function extractRelativePath(url: InternalUrl): string {
	const host = url.rawHost || url.hostname;
	const pathname = url.rawPathname ?? url.pathname;

	const combined = host
		? pathname && pathname !== "/"
			? `${host}${pathname}`
			: host
		: pathname && pathname !== "/"
			? pathname.slice(1)
			: "";

	if (!combined) {
		return "";
	}

	let decoded: string;
	try {
		decoded = decodeURIComponent(combined.replaceAll("\\", "/"));
	} catch {
		throw new Error(`Invalid URL encoding in local:// path: ${url.href}`);
	}
	try {
		validateRelativePath(decoded, "local");
	} catch (error) {
		throw toLocalValidationError(error);
	}
	return decoded;
}

export function resolveLocalRoot(options: LocalProtocolOptions, platform: NodeJS.Platform = process.platform): string {
	const artifactsDir = options.getArtifactsDir?.();
	if (artifactsDir) {
		const candidate = path.resolve(artifactsDir, "local");
		if (platform === "win32" && candidate.length >= WINDOWS_LOCAL_ROOT_MAX_CHARS) {
			return shortLocalRoot(options);
		}
		return candidate;
	}

	return path.join(os.tmpdir(), "veyyon-local", safeSessionId(options));
}

export async function listLocalPlanFileUrls(localRoot: string): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(localRoot, { withFileTypes: true });
	} catch (err) {
		if (!isEnoent(err)) {
			logger.warn("Local plan root could not be read; plan approval has no plan files to fall back on", {
				root: localRoot,
				error: errorMessage(err),
			});
		}
		return [];
	}
	const plans = await Promise.all(
		entries
			.filter(entry => entry.isFile() && /plan\.md$/i.test(entry.name))
			.map(async entry => {
				const stat = await fs.stat(path.join(localRoot, entry.name)).catch(() => null);
				return { url: `local://${entry.name}`, mtime: stat?.mtimeMs ?? 0 };
			}),
	);
	return plans.sort((left, right) => right.mtime - left.mtime).map(plan => plan.url);
}

export function resolveLocalUrlToPath(
	input: string | InternalUrl,
	options: LocalProtocolOptions,
	platform: NodeJS.Platform = process.platform,
): string {
	const url = typeof input === "string" ? parseLocalUrl(input) : input;
	const localRoot = path.resolve(resolveLocalRoot(options, platform));
	const relativePath = extractRelativePath(url);

	if (!relativePath) {
		return localRoot;
	}

	const resolved = path.resolve(localRoot, relativePath);
	ensureWithinRoot(resolved, localRoot);
	return resolved;
}

export function buildEvalUrlRoots(options: LocalProtocolOptions): Record<string, string> {
	return { local: resolveLocalRoot(options) };
}

export const LOCAL_WRITE_NOTE = "Use write path local://<file> to persist large intermediate artifacts across turns.";

export type ResolvedLocalTarget =
	| { kind: "listing"; root: string }
	| { kind: "directory"; path: string }
	| { kind: "file"; path: string; size: number };

export async function resolveLocalTarget(url: InternalUrl, opts: LocalProtocolOptions): Promise<ResolvedLocalTarget> {
	const localRoot = path.resolve(resolveLocalRoot(opts));
	await fs.mkdir(localRoot, { recursive: true });

	let resolvedRoot: string;
	try {
		resolvedRoot = await fs.realpath(localRoot);
	} catch (error) {
		if (isEnoent(error)) {
			throw new Error("Unable to initialize local:// root");
		}
		throw error;
	}

	const relativePath = extractRelativePath(url);
	const targetPath = relativePath ? path.resolve(resolvedRoot, relativePath) : resolvedRoot;
	ensureWithinRoot(targetPath, resolvedRoot);

	if (targetPath === resolvedRoot) {
		return { kind: "listing", root: resolvedRoot };
	}

	const parentDir = path.dirname(targetPath);
	try {
		const realParent = await fs.realpath(parentDir);
		ensureWithinRoot(realParent, resolvedRoot);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	let realTargetPath: string;
	try {
		realTargetPath = await fs.realpath(targetPath);
	} catch (error) {
		if (isEnoent(error)) {
			throw new Error(`Local file not found: ${url.href}`);
		}
		throw error;
	}

	ensureWithinRoot(realTargetPath, resolvedRoot);

	const stat = await fs.stat(realTargetPath);
	if (stat.isDirectory()) {
		return { kind: "directory", path: realTargetPath };
	}
	if (!stat.isFile()) {
		throw new Error(`local:// URL must resolve to a file or directory: ${url.href}`);
	}
	return { kind: "file", path: realTargetPath, size: stat.size };
}
