import type { SubprocessToolHandler } from "./subprocess-tool-registry-helpers";

export { YIELD_TOOL_NAME } from "./subprocess-tool-registry-helpers";

class SubprocessToolRegistryImpl {
	#handlers = new Map<string, SubprocessToolHandler>();

	register<T>(toolName: string, handler: SubprocessToolHandler<T>): void {
		this.#handlers.set(toolName, handler as SubprocessToolHandler);
	}

	getHandler(toolName: string): SubprocessToolHandler | undefined {
		return this.#handlers.get(toolName);
	}

	hasHandler(toolName: string): boolean {
		return this.#handlers.has(toolName);
	}

	getRegisteredTools(): string[] {
		return Array.from(this.#handlers.keys());
	}
}

export const subprocessToolRegistry = new SubprocessToolRegistryImpl();
