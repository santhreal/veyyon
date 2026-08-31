/**
 * Protocol handler for veyyon:// URLs.
 *
 * Serves statically embedded documentation files bundled at build time.
 *
 * URL forms:
 * - veyyon:// - Lists all available documentation files
 * - veyyon://<file>.md - Reads a specific documentation file
 *
 */
import * as path from "node:path";
import { getDocFilenames, getEmbeddedDoc } from "./docs-index";
import type { InternalResource, InternalUrl, ProtocolHandler, UrlCompletion } from "./types";

/**
 * Handler for veyyon:// URLs.
 *
 * Resolves documentation file names to their content, or lists available docs.
 */
export class VeyyonProtocolHandler implements ProtocolHandler {
	readonly scheme = "veyyon";
	readonly immutable = true;

	async resolve(url: InternalUrl): Promise<InternalResource> {
		// Extract filename from host + path
		const host = url.rawHost || url.hostname;
		const pathname = url.rawPathname ?? url.pathname;
		const filename = host ? (pathname && pathname !== "/" ? host + pathname : host) : "";

		if (!filename) {
			return this.#listDocs(url);
		}

		return this.#readDoc(filename, url);
	}

	async complete(): Promise<UrlCompletion[]> {
		return getDocFilenames().map(value => ({ value }));
	}

	async #listDocs(url: InternalUrl): Promise<InternalResource> {
		const filenames = getDocFilenames();
		if (filenames.length === 0) {
			throw new Error("No documentation files found");
		}

		const listing = filenames.map(f => `- [${f}](veyyon://${f})`).join("\n");
		const content = `# Documentation\n\n${filenames.length} files available:\n\n${listing}\n`;

		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
		};
	}

	async #readDoc(filename: string, url: InternalUrl): Promise<InternalResource> {
		// Validate: no traversal, no absolute paths
		if (path.isAbsolute(filename)) {
			throw new Error("Absolute paths are not allowed in veyyon:// URLs");
		}

		const normalized = path.posix.normalize(filename.replaceAll("\\", "/"));
		if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
			throw new Error("Path traversal (..) is not allowed in veyyon:// URLs");
		}

		const docPath =
			normalized === "docs" ? "" : normalized.startsWith("docs/") ? normalized.slice("docs/".length) : normalized;
		if (!docPath) {
			return this.#listDocs(url);
		}

		const content = (await getEmbeddedDoc(docPath)) ?? (await this.#readByBasename(docPath));
		if (content === undefined) {
			const lookup = docPath.replace(/\.md$/, "");
			const suggestions = getDocFilenames()
				.filter(f => f.includes(lookup) || lookup.includes(f.replace(/\.md$/, "")))
				.slice(0, 5);
			const suffix =
				suggestions.length > 0
					? `\nDid you mean: ${suggestions.join(", ")}`
					: "\nUse veyyon:// to list available files.";
			throw new Error(`Documentation file not found: ${filename}${suffix}`);
		}

		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
		};
	}

	/**
	 * Second chance for a path that names the right page in the wrong directory.
	 *
	 * Documentation is reorganized, and every reference to it does not move in the same commit: a
	 * prompt, a comment, a changelog entry and an operator's memory all carry the old path. A page
	 * that still exists under one name in the tree is served under it, so `veyyon://docs/secrets.md`
	 * keeps working after the page becomes `handbook/src/architecture/secrets.md`.
	 *
	 * AMBIGUITY IS A MISS, not a guess. Two pages with the same basename are two different pages,
	 * and picking either one silently answers a question that was not asked; the caller falls
	 * through to the suggestion list, which names both.
	 */
	async #readByBasename(docPath: string): Promise<string | undefined> {
		const wanted = docPath.split("/").at(-1);
		const matches = getDocFilenames().filter(f => f.split("/").at(-1) === wanted);
		return matches.length === 1 && matches[0] !== docPath ? await getEmbeddedDoc(matches[0]) : undefined;
	}
}
