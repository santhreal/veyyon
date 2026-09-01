import { isRecord } from "@veyyon/utils/type-guards";
import { isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "../timeout";

export const HTTP_SSE_CONNECT_TIMEOUT_MS = 1_000;

export const mcpToolArgsAttemptFactory = Symbol("mcpToolArgsAttemptFactory");

export type MCPToolArgsAttemptFactory = () => Promise<Record<string, unknown>>;

export type MCPToolArgsWithAttemptFactory = Record<string, unknown> & {
	[mcpToolArgsAttemptFactory]?: MCPToolArgsAttemptFactory;
};

export function retainMCPToolArgsAttemptFactory(
	args: Record<string, unknown>,
	attemptFactory: MCPToolArgsAttemptFactory,
): Record<string, unknown> {
	Object.defineProperty(args, mcpToolArgsAttemptFactory, {
		value: attemptFactory,
		configurable: false,
		enumerable: false,
		writable: false,
	});
	return args;
}

export async function rebuildMCPToolCallParamsForAttempt(
	params: Record<string, unknown> | undefined,
): Promise<Record<string, unknown> | undefined> {
	const args = params?.arguments;
	if (!isRecord(args)) return params;
	const attemptFactory = (args as MCPToolArgsWithAttemptFactory)[mcpToolArgsAttemptFactory];
	if (!attemptFactory) return params;
	return { ...params, arguments: await attemptFactory() };
}
export function resolveSSEConnectTimeoutMs(configTimeout?: number): number {
	const requestTimeout = resolveMCPTimeoutMs(configTimeout);
	if (!isMCPTimeoutEnabled(requestTimeout)) return 0;
	const boundedTimeout = Math.min(HTTP_SSE_CONNECT_TIMEOUT_MS, Math.floor(requestTimeout / 4));
	return Math.max(1, boundedTimeout);
}
