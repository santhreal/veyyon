import { describe, expect, it } from "bun:test";
import {
	type AwsCredentials,
	formatAmzDate,
	getSigningKey,
	sha256,
	sha256Hex,
	signRequest,
	toHex,
} from "../src/providers/aws-sigv4";

describe("toHex", () => {
	it("converts empty bytes to empty string", () => {
		expect(toHex(new Uint8Array(0))).toBe("");
	});

	it("converts single byte 0", () => {
		expect(toHex(new Uint8Array([0]))).toBe("00");
	});

	it("converts single byte 255", () => {
		expect(toHex(new Uint8Array([255]))).toBe("ff");
	});

	it("converts single byte 16", () => {
		expect(toHex(new Uint8Array([16]))).toBe("10");
	});

	it("converts multi-byte array", () => {
		expect(toHex(new Uint8Array([0, 1, 2, 255]))).toBe("000102ff");
	});

	it("converts all hex digits", () => {
		const bytes = new Uint8Array([
			0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
		]);
		expect(toHex(bytes)).toBe("00112233445566778899aabbccddeeff");
	});
});

describe("sha256", () => {
	it("returns 32-byte digest for empty string", async () => {
		const result = await sha256("");
		expect(result.length).toBe(32);
	});

	it("returns known hash for empty string", async () => {
		const hex = toHex(await sha256(""));
		expect(hex).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});

	it("returns known hash for 'abc'", async () => {
		const hex = toHex(await sha256("abc"));
		expect(hex).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});

	it("accepts Uint8Array input", async () => {
		const input = new TextEncoder().encode("abc");
		const hex = toHex(await sha256(input));
		expect(hex).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});

	it("returns different hashes for different inputs", async () => {
		const a = toHex(await sha256("hello"));
		const b = toHex(await sha256("world"));
		expect(a).not.toBe(b);
	});
});

describe("sha256Hex", () => {
	it("returns hex string for empty input", async () => {
		expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});

	it("returns hex string for 'abc'", async () => {
		expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});
});

describe("formatAmzDate", () => {
	it("formats a known date correctly", () => {
		const d = new Date("2024-01-15T10:30:45.000Z");
		const result = formatAmzDate(d);
		expect(result.longDate).toBe("20240115T103045Z");
		expect(result.shortDate).toBe("20240115");
	});

	it("formats epoch correctly", () => {
		const d = new Date(0);
		const result = formatAmzDate(d);
		expect(result.longDate).toBe("19700101T000000Z");
		expect(result.shortDate).toBe("19700101");
	});

	it("pads single-digit months and days", () => {
		const d = new Date("2024-03-05T01:02:03.000Z");
		const result = formatAmzDate(d);
		expect(result.longDate).toBe("20240305T010203Z");
		expect(result.shortDate).toBe("20240305");
	});

	it("shortDate is first 8 chars of longDate", () => {
		const d = new Date("2024-12-31T23:59:59.999Z");
		const result = formatAmzDate(d);
		expect(result.shortDate).toBe(result.longDate.slice(0, 8));
	});

	it("handles year with 4 digits", () => {
		const d = new Date("1999-06-15T12:00:00.000Z");
		const result = formatAmzDate(d);
		expect(result.longDate.startsWith("1999")).toBe(true);
	});
});

describe("getSigningKey", () => {
	it("returns 32-byte key", async () => {
		const key = await getSigningKey("secret", "20240115", "us-east-1", "bedrock");
		expect(key.length).toBe(32);
	});

	it("returns deterministic key for same inputs", async () => {
		const a = await getSigningKey("secret", "20240115", "us-east-1", "bedrock");
		const b = await getSigningKey("secret", "20240115", "us-east-1", "bedrock");
		expect(toHex(a)).toBe(toHex(b));
	});

	it("returns different keys for different regions", async () => {
		const a = await getSigningKey("secret", "20240115", "us-east-1", "bedrock");
		const b = await getSigningKey("secret", "20240115", "eu-west-1", "bedrock");
		expect(toHex(a)).not.toBe(toHex(b));
	});

	it("returns different keys for different services", async () => {
		const a = await getSigningKey("secret", "20240115", "us-east-1", "bedrock");
		const b = await getSigningKey("secret", "20240115", "us-east-1", "s3");
		expect(toHex(a)).not.toBe(toHex(b));
	});

	it("returns different keys for different dates", async () => {
		const a = await getSigningKey("secret", "20240115", "us-east-1", "bedrock");
		const b = await getSigningKey("secret", "20240116", "us-east-1", "bedrock");
		expect(toHex(a)).not.toBe(toHex(b));
	});

	it("returns different keys for different secrets", async () => {
		const a = await getSigningKey("secret1", "20240115", "us-east-1", "bedrock");
		const b = await getSigningKey("secret2", "20240115", "us-east-1", "bedrock");
		expect(toHex(a)).not.toBe(toHex(b));
	});
});

describe("signRequest", () => {
	const credentials: AwsCredentials = {
		accessKeyId: "AKIATESTKEY",
		secretAccessKey: "secretTestKey",
	};

	it("returns signed headers with required fields", async () => {
		const result = await signRequest({
			method: "POST",
			host: "bedrock-runtime.us-east-1.amazonaws.com",
			path: "/model/test/invoke",
			body: new TextEncoder().encode("{}"),
			region: "us-east-1",
			service: "bedrock",
			credentials,
			date: new Date("2024-01-15T10:30:45.000Z"),
		});
		expect(result.host).toBe("bedrock-runtime.us-east-1.amazonaws.com");
		expect(result["x-amz-date"]).toBe("20240115T103045Z");
		expect(result["x-amz-content-sha256"]).toBeTruthy();
		expect(result.authorization).toContain("AWS4-HMAC-SHA256");
		expect(result.authorization).toContain("AKIATESTKEY");
	});

	it("includes session token in headers when provided", async () => {
		const result = await signRequest({
			method: "POST",
			host: "example.com",
			path: "/",
			body: new Uint8Array(0),
			region: "us-east-1",
			service: "bedrock",
			credentials: { ...credentials, sessionToken: "session-token-123" },
			date: new Date("2024-01-15T10:30:45.000Z"),
		});
		expect(result["x-amz-security-token"]).toBe("session-token-123");
	});

	it("omits session token when not provided", async () => {
		const result = await signRequest({
			method: "POST",
			host: "example.com",
			path: "/",
			body: new Uint8Array(0),
			region: "us-east-1",
			service: "bedrock",
			credentials,
			date: new Date("2024-01-15T10:30:45.000Z"),
		});
		expect(result["x-amz-security-token"]).toBeUndefined();
	});

	it("produces deterministic signatures for same inputs", async () => {
		const params = {
			method: "POST",
			host: "example.com",
			path: "/test",
			body: new TextEncoder().encode("hello"),
			region: "us-east-1",
			service: "bedrock",
			credentials,
			date: new Date("2024-01-15T10:30:45.000Z"),
		};
		const a = await signRequest(params);
		const b = await signRequest({ ...params, body: new TextEncoder().encode("hello") });
		expect(a.authorization).toBe(b.authorization);
	});

	it("produces different signatures for different bodies", async () => {
		const base = {
			method: "POST",
			host: "example.com",
			path: "/test",
			region: "us-east-1",
			service: "bedrock",
			credentials,
			date: new Date("2024-01-15T10:30:45.000Z"),
		};
		const a = await signRequest({ ...base, body: new TextEncoder().encode("hello") });
		const b = await signRequest({ ...base, body: new TextEncoder().encode("world") });
		expect(a.authorization).not.toBe(b.authorization);
	});

	it("handles query string in canonical request", async () => {
		const result = await signRequest({
			method: "GET",
			host: "example.com",
			path: "/path",
			query: "b=2&a=1",
			body: new Uint8Array(0),
			region: "us-east-1",
			service: "bedrock",
			credentials,
			date: new Date("2024-01-15T10:30:45.000Z"),
		});
		expect(result.authorization).toContain("AWS4-HMAC-SHA256");
	});

	it("handles custom headers", async () => {
		const result = await signRequest({
			method: "POST",
			host: "example.com",
			path: "/",
			headers: { "x-custom-header": "value" },
			body: new Uint8Array(0),
			region: "us-east-1",
			service: "bedrock",
			credentials,
			date: new Date("2024-01-15T10:30:45.000Z"),
		});
		expect(result.authorization).toContain("x-custom-header");
	});
});
