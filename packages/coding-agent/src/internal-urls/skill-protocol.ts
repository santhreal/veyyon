/**
 * Protocol handler for skill:// URLs.
 *
 * Resolves skill names to their SKILL.md files or relative paths within skill directories.
 *
 * URL forms:
 * - skill://<name> - Reads SKILL.md
 * - skill://<name>/<path> - Reads relative path within skill's baseDir
 */
import type * as fsTypes from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
// Owners, not the `@veyyon/utils` barrel: 1 module against 74.
import { isEnoent } from "@veyyon/utils/fs-error";
// The slot, not the loader: `../extensibility/skills` discovers and parses skills and reaches 365
// modules, and this handler only reads which ones are active.
import { getActiveSkills } from "../extensibility/active-skills";
import { getContentType } from "./content-type";
import { buildDirectoryResource, ensureWithinRoot } from "./filesystem-resource";
import { validateRelativePath } from "./relative-path";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

/**
 * Re-exported from its leaf so the four other schemes that call it do not import this handler.
 *
 * This module reaches 378 modules through `extensibility/skills`; the check itself imports only
 * `node:path`. It is still named here because `internal-urls/index` re-exports this file.
 */
export { validateRelativePath } from "./relative-path";

/**
 * Handler for skill:// URLs.
 */
export class SkillProtocolHandler implements ProtocolHandler {
	readonly scheme = "skill";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const skills = context?.skills ?? getActiveSkills();

		const skillName = url.rawHost || url.hostname;
		if (!skillName) {
			throw new Error("skill:// URL requires a skill name: skill://<name>");
		}

		const skill = skills.find(s => s.name === skillName);
		if (!skill) {
			const available = skills.map(s => s.name);
			const availableStr = available.length > 0 ? available.join(", ") : "none";
			throw new Error(`Unknown skill: ${skillName}\nAvailable: ${availableStr}`);
		}

		let targetPath: string;
		const urlPath = url.pathname;
		const hasRelativePath = urlPath && urlPath !== "/" && urlPath !== "";

		if (hasRelativePath) {
			const relativePath = decodeURIComponent(urlPath.slice(1));
			validateRelativePath(relativePath);
			targetPath = path.join(skill.baseDir, relativePath);
		} else {
			targetPath = context?.pathOnly === true ? skill.baseDir : skill.filePath;
		}

		let resolvedBaseDir: string;
		let resolvedTargetPath: string;
		try {
			[resolvedBaseDir, resolvedTargetPath] = await Promise.all([
				fs.realpath(skill.baseDir),
				fs.realpath(targetPath),
			]);
		} catch (error) {
			if (isEnoent(error)) {
				throw new Error(`File not found: ${targetPath}`);
			}
			throw error;
		}
		ensureWithinRoot(resolvedTargetPath, resolvedBaseDir, "skill");
		targetPath = resolvedTargetPath;

		const stats: fsTypes.Stats = await fs.stat(targetPath);

		if (stats.isDirectory()) {
			return buildDirectoryResource(url.href, targetPath);
		}
		if (!stats.isFile()) {
			throw new Error(`skill:// URL must resolve to a file or directory: ${url.href}`);
		}

		const content = await Bun.file(targetPath).text();
		return {
			url: url.href,
			content,
			contentType: getContentType(targetPath),
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: targetPath,
			notes: [],
		};
	}

	async complete(_query?: string, context?: ResolveContext): Promise<UrlCompletion[]> {
		return (context?.skills ?? getActiveSkills()).map(skill => ({
			value: skill.name,
			...(skill.description ? { description: skill.description } : {}),
		}));
	}
}
