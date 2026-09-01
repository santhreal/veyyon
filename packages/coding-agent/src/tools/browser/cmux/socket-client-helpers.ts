export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type RequestJob = {
	method: string;
	params: Record<string, unknown>;
	timeoutMs: number;
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: unknown) => void;
};

export type LineWaiter = {
	resolve: (line: string) => void;
	reject: (error: unknown) => void;
	timer: NodeJS.Timeout;
};

export type CmuxErrorPayload = {
	code?: unknown;
	message?: unknown;
	details?: unknown;
};

export function formatCmuxError(error: CmuxErrorPayload | undefined): string {
	const code = typeof error?.code === "string" && error.code.length > 0 ? error.code : "error";
	const message = typeof error?.message === "string" && error.message.length > 0 ? error.message : "cmux error";
	const details = error?.details === undefined ? "" : ` details=${JSON.stringify(error.details)}`;
	return `${code}: ${message}${details}`;
}
