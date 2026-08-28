import { asStrictBytes } from "@veyyon/utils/bytes";

export interface AwsCredentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
}

export interface SignParams {
	method: string;
	host: string;
	path: string;
	query?: string;
	headers?: Record<string, string>;
	body: Uint8Array;
	region: string;
	service: string;
	credentials: AwsCredentials;
	date?: Date;
}

const ALGORITHM = "AWS4-HMAC-SHA256";
const KEY_TYPE = "aws4_request";
const UNSIGNABLE: Record<string, true> = {
	authorization: true,
	"cache-control": true,
	connection: true,
	expect: true,
	from: true,
	"keep-alive": true,
	"max-forwards": true,
	pragma: true,
	referer: true,
	te: true,
	trailer: true,
	"transfer-encoding": true,
	upgrade: true,
	"user-agent": true,
	"x-amzn-trace-id": true,
};

const subtle = globalThis.crypto.subtle;

const HEX = "0123456789abcdef";
export function toHex(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i++) {
		const b = bytes[i];
		out += HEX[b >> 4] + HEX[b & 15];
	}
	return out;
}

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
	const bytes = typeof data === "string" ? new TextEncoder().encode(data) : asStrictBytes(data);
	const digest = await subtle.digest("SHA-256", bytes);
	return new Uint8Array(digest);
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
	return toHex(await sha256(data));
}

async function hmac(key: Uint8Array, data: string | Uint8Array): Promise<Uint8Array> {
	const cryptoKey = await subtle.importKey("raw", asStrictBytes(key), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	const bytes = typeof data === "string" ? new TextEncoder().encode(data) : asStrictBytes(data);
	const sig = await subtle.sign("HMAC", cryptoKey, bytes);
	return new Uint8Array(sig);
}

export async function getSigningKey(
	secretAccessKey: string,
	shortDate: string,
	region: string,
	service: string,
): Promise<Uint8Array> {
	const kDate = await hmac(new TextEncoder().encode(`AWS4${secretAccessKey}`), shortDate);
	const kRegion = await hmac(kDate, region);
	const kService = await hmac(kRegion, service);
	return hmac(kService, KEY_TYPE);
}

export function formatAmzDate(d: Date): { longDate: string; shortDate: string } {
	const iso = d.toISOString();
	const longDate = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
	return { longDate, shortDate: longDate.slice(0, 8) };
}

function canonicalPath(path: string): string {
	const segments = path.split("/");
	const escaped = segments.map(seg => (seg.length === 0 ? "" : encodeRfc3986(seg)));
	return escaped.join("/");
}

function encodeRfc3986(str: string): string {
	return encodeURIComponent(str).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(query: string | undefined): string {
	if (!query) return "";
	const pairs: Array<[string, string]> = [];
	for (const part of query.split("&")) {
		if (!part) continue;
		const eq = part.indexOf("=");
		const k = eq === -1 ? part : part.slice(0, eq);
		const v = eq === -1 ? "" : part.slice(eq + 1);
		pairs.push([decodeURIComponent(k), decodeURIComponent(v)]);
	}
	pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
	return pairs.map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`).join("&");
}

export interface SignedHeaders {
	host: string;
	"x-amz-date": string;
	"x-amz-content-sha256": string;
	authorization: string;
	"x-amz-security-token"?: string;
}

export async function signRequest(params: SignParams): Promise<SignedHeaders> {
	const { method, host, path, query, body, region, service, credentials } = params;
	const date = params.date ?? new Date();
	const { longDate, shortDate } = formatAmzDate(date);
	const payloadHash = await sha256Hex(body);

	const signed: Record<string, string> = {
		host,
		"x-amz-date": longDate,
		"x-amz-content-sha256": payloadHash,
	};
	if (credentials.sessionToken) signed["x-amz-security-token"] = credentials.sessionToken;
	const extraHeaders = params.headers;
	if (extraHeaders) {
		for (const k in extraHeaders) {
			const lk = k.toLowerCase();
			if (Object.hasOwn(UNSIGNABLE, lk)) continue;
			if (lk.startsWith("proxy-") || lk.startsWith("sec-")) continue;
			signed[lk] = extraHeaders[k].trim().replace(/\s+/g, " ");
		}
	}

	const sortedNames = Object.keys(signed).sort();
	const canonicalHeaders = `${sortedNames.map(n => `${n}:${signed[n]}`).join("\n")}\n`;
	const signedHeadersStr = sortedNames.join(";");

	const canonicalRequest = [
		method.toUpperCase(),
		canonicalPath(path),
		canonicalQuery(query),
		canonicalHeaders,
		signedHeadersStr,
		payloadHash,
	].join("\n");

	const scope = `${shortDate}/${region}/${service}/${KEY_TYPE}`;
	const stringToSign = [ALGORITHM, longDate, scope, await sha256Hex(canonicalRequest)].join("\n");

	const signingKey = await getSigningKey(credentials.secretAccessKey, shortDate, region, service);
	const signature = toHex(await hmac(signingKey, stringToSign));

	const authorization =
		`${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, ` +
		`SignedHeaders=${signedHeadersStr}, Signature=${signature}`;

	const out: SignedHeaders = {
		host,
		"x-amz-date": longDate,
		"x-amz-content-sha256": payloadHash,
		authorization,
	};
	if (credentials.sessionToken) out["x-amz-security-token"] = credentials.sessionToken;
	return out;
}
