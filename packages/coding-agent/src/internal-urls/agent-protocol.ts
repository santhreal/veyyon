/**
 * Protocol handler for agent:// URLs.
 *
 * Resolves agent output IDs against the artifacts directories of every active
 * session. Parents and subagents share outputs via this registry: a subagent
 * can read its parent's output IDs because both sessions are registered in
 * the shared context.
 *
 * URL forms:
 * - agent://<id> - Full output content
 * - agent://<id>/<path> - JSON extraction via path form
 * - agent://<id>?q=<query> - JSON extraction via query form
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
// Owners, not the `@veyyon/utils` barrel: 2 modules against 74.
import { isEnoent } from "@veyyon/utils/fs-error";
import { errorMessage } from "@veyyon/utils/type-guards";
import { applyQuery, pathToQuery } from "./json-query";
import { artifactsDirsFromRegistry } from "./registry-helpers";
import type { InternalResource, InternalUrl, ProtocolHandler, UrlCompletion } from "./types";

/**
 * Handler for agent:// URLs.
 *
 * Resolves output IDs like "reviewer_0" to their artifact files,
 * with optional JSON extraction.
 */
export class AgentProtocolHandler implements ProtocolHandler {
	readonly scheme = "agent";
	readonly immutable = true;

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const outputId = url.rawHost || url.hostname;
		if (!outputId) {
			throw new Error("agent:// URL requires an output ID: agent://<id>");
		}

		const urlPath = url.pathname;
		const queryParam = url.searchParams.get("q");
		const hasPathExtraction = urlPath && urlPath !== "/" && urlPath !== "";
		const hasQueryExtraction = queryParam !== null && queryParam !== "";

		if (hasPathExtraction && hasQueryExtraction) {
			throw new Error("agent:// URL cannot combine path extraction with ?q=");
		}

		const dirs = artifactsDirsFromRegistry();

		if (dirs.length === 0) {
			throw new Error("No session - agent outputs unavailable");
		}

		// EVERY dir is searched, not just up to the first hit. Output ids are the
		// task names a model chose (`Reviewer.md`), the artifacts dirs of every
		// registered session are searched in registry order, and two conversations
		// in one process routinely each produce a `Reviewer`. "First dir wins" then
		// silently returned another conversation's result for this conversation's
		// id, the same defect the transcript scan in `registry-helpers` already
		// refuses, left open on the sibling scheme that reads the `.md` beside it.
		const matches: string[] = [];
		let anyDirExists = false;
		const availableIds = new Set<string>();

		for (const dir of dirs) {
			try {
				await fs.stat(dir);
				anyDirExists = true;
			} catch (err) {
				if (isEnoent(err)) continue;
				throw err;
			}
			const candidate = path.join(dir, `${outputId}.md`);
			try {
				await fs.stat(candidate);
				// Overlapping roots can reach one file twice; only DISTINCT paths are
				// a collision.
				if (!matches.includes(candidate)) matches.push(candidate);
				continue;
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}
			try {
				const files = await fs.readdir(dir);
				for (const f of files) {
					if (f.endsWith(".md")) availableIds.add(f.replace(/\.md$/, ""));
				}
			} catch {
				// Listing failures are non-fatal; continue searching.
			}
		}

		if (!anyDirExists) {
			throw new Error("No artifacts directory found");
		}

		if (matches.length > 1) {
			throw new Error(
				`Ambiguous agent output: ${outputId}\n` +
					`More than one conversation in this process produced an output with that id, so the id alone ` +
					`cannot say which one you mean, and returning either would be a guess.\n` +
					`Read it from the session that spawned the agent, or open the file directly:\n` +
					matches.map(candidate => `  ${candidate}`).join("\n"),
			);
		}

		const foundPath = matches[0];
		if (!foundPath) {
			const availableStr = availableIds.size > 0 ? [...availableIds].join(", ") : "none";
			throw new Error(`Not found: ${outputId}\nAvailable: ${availableStr}`);
		}

		const rawContent = await Bun.file(foundPath).text();
		const notes: string[] = [];
		let content = rawContent;
		let contentType: InternalResource["contentType"] = "text/markdown";

		if (hasPathExtraction || hasQueryExtraction) {
			let jsonValue: unknown;
			try {
				jsonValue = JSON.parse(rawContent);
			} catch (err) {
				const message = errorMessage(err);
				throw new Error(`Output ${outputId} is not valid JSON: ${message}`);
			}

			const query = hasPathExtraction ? pathToQuery(urlPath) : queryParam!;
			if (query) {
				const extracted = applyQuery(jsonValue, query);
				try {
					content = JSON.stringify(extracted, null, 2) ?? "null";
				} catch {
					content = String(extracted);
				}
				notes.push(`Extracted: ${query}`);
			} else {
				content = JSON.stringify(jsonValue, null, 2);
			}
			contentType = "application/json";
		}

		return {
			url: url.href,
			content,
			contentType,
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: foundPath,
			notes,
		};
	}

	async complete(): Promise<UrlCompletion[]> {
		const ids = new Set<string>();
		for (const dir of artifactsDirsFromRegistry()) {
			let files: string[];
			try {
				files = await fs.readdir(dir);
			} catch (err) {
				if (isEnoent(err)) continue;
				throw err;
			}
			for (const f of files) {
				if (f.endsWith(".md")) ids.add(f.slice(0, -3));
			}
		}
		return [...ids].sort().map(value => ({ value }));
	}
}
