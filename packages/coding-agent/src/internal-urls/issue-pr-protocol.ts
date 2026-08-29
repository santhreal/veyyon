import { errorMessage } from "@veyyon/utils/type-guards";
import { getOrFetchIssue, getOrFetchPr, resolveDefaultRepoMemoized } from "../tools/gh-fetch";

import {
	buildSingleResource,
	fetchAndRenderList,
	fetchAndRenderPrDiff,
	parseUrl,
	resolveCwd,
	settingsFromContext,
} from "./issue-pr-protocol-helpers";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext } from "./types";

export class IssueProtocolHandler implements ProtocolHandler {
	readonly scheme = "issue";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		if (context?.signal?.aborted) {
			throw new Error("aborted");
		}
		const parsed = parseUrl(url, "issue");
		if (parsed.kind === "list") {
			try {
				return await fetchAndRenderList("issue", parsed, url, context);
			} catch (err) {
				const message = errorMessage(err);
				throw new Error(`issue:// listing failed: ${message}`);
			}
		}
		if (parsed.kind !== "single") {
			throw new Error(`Invalid issue:// URL: unexpected variant '${parsed.kind}'`);
		}
		try {
			const lookup = await getOrFetchIssue({
				cwd: resolveCwd(context),
				repo: parsed.repo,
				issue: String(parsed.number),
				includeComments: parsed.comments,
				signal: context?.signal,
				settings: settingsFromContext(context),
			});
			return buildSingleResource({
				url,
				scheme: "issue",
				parsed,
				rendered: lookup.rendered,
				status: lookup.status,
				fetchedAt: lookup.fetchedAt,
			});
		} catch (err) {
			const message = errorMessage(err);
			throw new Error(`issue:// resolution failed: ${message}`);
		}
	}
}

export class PrProtocolHandler implements ProtocolHandler {
	readonly scheme = "pr";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		if (context?.signal?.aborted) {
			throw new Error("aborted");
		}
		const parsed = parseUrl(url, "pr");
		if (parsed.kind === "list") {
			try {
				return await fetchAndRenderList("pr", parsed, url, context);
			} catch (err) {
				const message = errorMessage(err);
				throw new Error(`pr:// listing failed: ${message}`);
			}
		}
		if (parsed.kind === "pr-diff") {
			try {
				return await fetchAndRenderPrDiff(url, parsed, context);
			} catch (err) {
				const message = errorMessage(err);
				throw new Error(`pr:// diff resolution failed: ${message}`);
			}
		}
		const cwd = resolveCwd(context);
		let repo = parsed.repo;
		if (!repo) {
			try {
				repo = await resolveDefaultRepoMemoized(cwd, context?.signal);
			} catch (err) {
				const message = errorMessage(err);
				throw new Error(
					`pr://${parsed.number} could not resolve a default repo from the current session: ${message}\nUse pr://<owner>/<repo>/${parsed.number}.`,
				);
			}
		}
		try {
			const lookup = await getOrFetchPr({
				cwd,
				repo,
				number: parsed.number,
				includeComments: parsed.comments,
				signal: context?.signal,
				settings: settingsFromContext(context),
			});
			return buildSingleResource({
				url,
				scheme: "pr",
				parsed,
				rendered: lookup.rendered,
				status: lookup.status,
				fetchedAt: lookup.fetchedAt,
				repo,
			});
		} catch (err) {
			const message = errorMessage(err);
			throw new Error(`pr:// resolution failed: ${message}`);
		}
	}
}
