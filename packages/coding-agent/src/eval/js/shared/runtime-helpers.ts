import type { JsDisplayOutput } from "./types";

export interface RuntimeHooks {
	onText(chunk: string): void;
	onDisplay(output: JsDisplayOutput): void;
	callTool(name: string, args: unknown): Promise<unknown>;
}

export interface RunContext {
	runId: string;
	hooks: RuntimeHooks;
	cwd: string;
	finalExpressionSet: boolean;
	finalExpressionValue: unknown;
}

export interface RuntimeOptions {
	initialCwd: string;
	sessionId: string;
	extraGlobals?: Record<string, unknown>;
	localRoots?: Record<string, string>;
	artifactsDir?: string | null;
}

export const BASE64_STRICT_RE = /^[A-Za-z0-9+/]+={0,2}$/;
export const DECIMAL_CSV_RE = /^\d{1,3}(?:,\d{1,3})*$/;

export const PRELUDE_GLOBAL_KEYS = [
	"__veyyon_js_prelude_loaded__",
	"console",
	"print",
	"display",
	"tool",
	"completion",
	"output",
	"agent",
	"parallel",
	"pipeline",
	"log",
	"phase",
	"budget",
	"__pool",
	"read",
	"write",
	"env",
	"kv",
	"defs",
	"__veyyon_prelude_baseline__",
];

function isStrictBase64(s: string): boolean {
	if (s.length === 0 || s.length % 4 !== 0) return false;
	return BASE64_STRICT_RE.test(s);
}

export function coerceImageBase64(data: unknown): string | null {
	if (typeof data === "string") {
		if (isStrictBase64(data)) return data;
		if (DECIMAL_CSV_RE.test(data)) {
			const parts = data.split(",");
			const bytes = new Uint8Array(parts.length);
			for (let i = 0; i < parts.length; i++) {
				const n = Number(parts[i]);
				if (!Number.isInteger(n) || n < 0 || n > 255) return null;
				bytes[i] = n;
			}
			return Buffer.from(bytes).toString("base64");
		}
		return null;
	}
	if (data instanceof Uint8Array) return Buffer.from(data).toString("base64");
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString("base64");
	if (ArrayBuffer.isView(data)) {
		const view = data as ArrayBufferView;
		return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("base64");
	}
	if (data && typeof data === "object") {
		const obj = data as { type?: unknown; data?: unknown };
		if (obj.type === "Buffer" && Array.isArray(obj.data)) {
			const arr = obj.data as unknown[];
			const bytes = new Uint8Array(arr.length);
			for (let i = 0; i < arr.length; i++) {
				const n = arr[i];
				if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 255) return null;
				bytes[i] = n;
			}
			return Buffer.from(bytes).toString("base64");
		}
	}
	return null;
}

export function describeDataType(data: unknown): string {
	if (data === null) return "null";
	if (data instanceof Uint8Array) return "Uint8Array";
	if (data instanceof ArrayBuffer) return "ArrayBuffer";
	if (ArrayBuffer.isView(data)) return data.constructor.name;
	if (typeof data === "string") return `string(${data.length})`;
	return typeof data;
}
