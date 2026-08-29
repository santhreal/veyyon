import * as path from "node:path";
import { isEnoent } from "@veyyon/utils/fs-error";
import { type AgentRef, AgentRegistry } from "../registry/agent-registry";
import { buildDirectoryResource } from "./filesystem-resource";
import type { LocalProtocolOptions } from "./local-protocol-helpers";
import {
	buildFileResource,
	buildListing,
	LOCAL_WRITE_NOTE,
	listFilesRecursively,
	parseLocalUrl,
	resolveLocalRoot,
	resolveLocalTarget,
} from "./local-protocol-helpers";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

export type { LocalProtocolOptions } from "./local-protocol-helpers";
export { buildEvalUrlRoots, listLocalPlanFileUrls, resolveLocalUrlToPath } from "./local-protocol-helpers";
export { resolveLocalRoot };

export async function resolveLocalUrlToFile(
	input: string | InternalUrl,
	context?: ResolveContext,
): Promise<{ path: string; size: number } | null> {
	const opts = LocalProtocolHandler.resolveOptions(context);
	if (!opts) return null;
	const url = typeof input === "string" ? parseLocalUrl(input) : input;
	const resolved = await resolveLocalTarget(url, opts);
	return resolved.kind === "file" ? { path: resolved.path, size: resolved.size } : null;
}

export class LocalProtocolHandler implements ProtocolHandler {
	readonly scheme = "local";
	readonly immutable = false;

	static #override: LocalProtocolOptions | undefined;

	static setOverride(value: LocalProtocolOptions | undefined): void {
		LocalProtocolHandler.#override = value;
	}

	static resetOverrideForTests(): void {
		LocalProtocolHandler.#override = undefined;
	}

	static resolveOptions(context?: ResolveContext): LocalProtocolOptions | undefined {
		const fromContext = context?.localProtocolOptions;
		if (fromContext) return fromContext;
		const override = LocalProtocolHandler.#override;
		if (override) return override;
		let main: AgentRef | undefined;
		for (const ref of AgentRegistry.global().list()) {
			if (ref.kind !== "main" || !ref.session?.sessionManager) continue;
			if (main) return undefined;
			main = ref;
		}
		const sessionManager = main?.session?.sessionManager;
		if (!sessionManager) return undefined;
		return {
			getArtifactsDir: () => sessionManager.getArtifactsDir(),
			getSessionId: () => sessionManager.getSessionId(),
		};
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const opts = LocalProtocolHandler.resolveOptions(context);
		if (!opts) {
			throw new Error("No session - local:// unavailable");
		}

		const resolved = await resolveLocalTarget(url, opts);
		if (resolved.kind === "listing") {
			return buildListing(url, resolved.root);
		}
		if (resolved.kind === "directory") {
			return buildDirectoryResource(url.href, resolved.path, [LOCAL_WRITE_NOTE]);
		}

		return buildFileResource(url, resolved);
	}

	async complete(_query?: string, context?: ResolveContext): Promise<UrlCompletion[]> {
		const opts = LocalProtocolHandler.resolveOptions(context);
		if (!opts) return [];
		const localRoot = path.resolve(resolveLocalRoot(opts));
		try {
			const files = await listFilesRecursively(localRoot);
			return files.map(value => ({ value }));
		} catch (err) {
			if (isEnoent(err)) return [];
			throw err;
		}
	}
}
