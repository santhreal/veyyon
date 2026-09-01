import * as fs from "node:fs";
import * as tls from "node:tls";
import { $env } from "./env";
import { isEnoent } from "./fs-error";

export type FetchImpl = ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) & {
	preconnect?: typeof globalThis.fetch.preconnect;
};

export class ExtraCaError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ExtraCaError";
	}
}

type BunTlsOptions = {
	ca?: string | string[];
	cert?: string;
	key?: string;
	rejectUnauthorized?: boolean;
	serverName?: string;
	ciphers?: string;
};

type BunTlsRequestInit = RequestInit & { tls?: BunTlsOptions };

const EXTRA_CA_FETCH_MARKER = Symbol("veyyon.extraCaFetch");
type ExtraCaFetch = FetchImpl & { [EXTRA_CA_FETCH_MARKER]?: true };

let cacheKey: string | undefined;
let cacheValue: string | undefined;

function resolveExtraCa(): string | undefined {
	const raw = $env.NODE_EXTRA_CA_CERTS?.trim();
	if (!raw) return undefined;

	let key: string;
	if (raw.includes("-----BEGIN")) {
		key = raw;
	} else {
		try {
			key = `${raw}@${fs.statSync(raw).mtimeMs}`;
		} catch {
			key = raw;
		}
	}
	if (key === cacheKey) return cacheValue;

	if (raw.includes("-----BEGIN")) {
		cacheValue = raw.replace(/\\n/g, "\n");
	} else {
		try {
			cacheValue = fs.readFileSync(raw, "utf8");
		} catch (error) {
			if (isEnoent(error)) {
				throw new ExtraCaError(`NODE_EXTRA_CA_CERTS path does not exist: ${raw}`);
			}
			throw error;
		}
	}
	cacheKey = key;
	return cacheValue;
}

export function __resetExtraCaCache(): void {
	cacheKey = undefined;
	cacheValue = undefined;
}

function withExtraCaInit(init: RequestInit | undefined, extraCa: string): RequestInit {
	const existingTls = (init as BunTlsRequestInit | undefined)?.tls;
	const existingCa = existingTls?.ca;
	let mergedCa: string[];
	if (existingCa === undefined) {
		mergedCa = tls.rootCertificates.concat([extraCa]);
	} else if (Array.isArray(existingCa)) {
		mergedCa = existingCa.concat([extraCa]);
	} else {
		mergedCa = [existingCa, extraCa];
	}
	return { ...init, tls: { ...existingTls, ca: mergedCa } } as RequestInit;
}

export function wrapFetchForExtraCa(fetchImpl: FetchImpl): FetchImpl {
	const maybeWrapped = fetchImpl as ExtraCaFetch;
	if (maybeWrapped[EXTRA_CA_FETCH_MARKER]) return fetchImpl;
	if (!$env.NODE_EXTRA_CA_CERTS?.trim()) return fetchImpl;

	const wrapped = Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const extraCa = resolveExtraCa();
			return extraCa ? fetchImpl(input, withExtraCaInit(init, extraCa)) : fetchImpl(input, init);
		},
		fetchImpl.preconnect ? { preconnect: fetchImpl.preconnect } : {},
		{ [EXTRA_CA_FETCH_MARKER]: true as const },
	);
	return wrapped;
}

export function withExtraCaFetch<T extends { fetch?: FetchImpl } | undefined>(options: T): T {
	if (!$env.NODE_EXTRA_CA_CERTS?.trim()) return options;
	const fetchImpl = options?.fetch ?? (globalThis.fetch as FetchImpl);
	const wrapped = wrapFetchForExtraCa(fetchImpl);
	if (wrapped === fetchImpl && options?.fetch !== undefined) return options;
	return { ...(options ?? {}), fetch: wrapped } as T;
}
