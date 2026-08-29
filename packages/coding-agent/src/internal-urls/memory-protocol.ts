import * as fs from "node:fs/promises";
import { isEnoent } from "@veyyon/utils/fs-error";
import {
	MEMORY_NAMESPACE,
	memoryRootsForContext,
	mnemopiSessionStatesFromRegistry,
	renderMnemopiMemory,
	tryResolveInRoot,
	tryResolveMnemopiMemory,
} from "./memory-protocol-helpers";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

export { memoryRootsFromRegistry, resolveMemoryUrlToPath } from "./memory-protocol-helpers";

export class MemoryProtocolHandler implements ProtocolHandler {
	readonly scheme = "memory";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const namespace = url.rawHost || url.hostname;
		if (!namespace) {
			throw new Error("memory:// URL requires a namespace: memory://root or memory://<memory-id>");
		}

		if (namespace !== MEMORY_NAMESPACE) {
			const mnemopiStates = mnemopiSessionStatesFromRegistry();
			if (mnemopiStates.length === 0) {
				throw new Error(
					`Unknown memory namespace: ${namespace}. Supported: ${MEMORY_NAMESPACE} (file-backed memory summary), or a mnemopi memory id when memory.backend=mnemopi is active.`,
				);
			}
			const hit = tryResolveMnemopiMemory(namespace);
			if (hit) return renderMnemopiMemory(url, hit);
			throw new Error(
				`Mnemopi memory ${namespace} not found in any scoped bank. Use \`recall\` to list available ids.`,
			);
		}

		const roots = memoryRootsForContext(context);
		if (roots.length === 0) {
			throw new Error(
				"Memory artifacts are not available for this project yet. Run a session with memories enabled first.",
			);
		}

		let anyExists = false;
		for (const root of roots) {
			try {
				await fs.stat(root);
				anyExists = true;
			} catch (error) {
				if (isEnoent(error)) continue;
				throw error;
			}
			const result = await tryResolveInRoot(url, root);
			if (result) return result;
		}

		if (!anyExists) {
			throw new Error(
				"Memory artifacts are not available for this project yet. Run a session with memories enabled first.",
			);
		}

		throw new Error(`Memory file not found: ${url.href}`);
	}

	async complete(_query?: string, context?: ResolveContext): Promise<UrlCompletion[]> {
		const completions: UrlCompletion[] = [];
		let projectRoots = 0;
		try {
			projectRoots = memoryRootsForContext(context).length;
		} catch {
			projectRoots = 0;
		}
		if (projectRoots > 0) {
			completions.push({ value: MEMORY_NAMESPACE, description: "Project memory summary" });
		}
		if (mnemopiSessionStatesFromRegistry().length > 0) {
			completions.push({
				value: "<memory-id>",
				description: "Full mnemopi memory by id (from recall)",
			});
		}
		return completions;
	}
}
