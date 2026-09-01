import { describe, expect, it } from "bun:test";
import { ConfigurationError } from "../src/error";
import { parseBind } from "../src/utils/parse-bind";

describe("parseBind", () => {
	it("parses bare port with default hostname", () => {
		expect(parseBind("8080")).toEqual({ hostname: "127.0.0.1", port: 8080 });
	});
	it("parses host:port", () => {
		expect(parseBind("0.0.0.0:3000")).toEqual({ hostname: "0.0.0.0", port: 3000 });
	});
	it("parses localhost:port", () => {
		expect(parseBind("localhost:9000")).toEqual({ hostname: "localhost", port: 9000 });
	});
	it("parses IPv6 address with port", () => {
		expect(parseBind("[::1]:8080")).toEqual({ hostname: "[::1]", port: 8080 });
	});
	it("parses IPv6 address without brackets", () => {
		expect(parseBind("::1:8080")).toEqual({ hostname: "::1", port: 8080 });
	});
	it("trims whitespace around input", () => {
		expect(parseBind("  8080  ")).toEqual({ hostname: "127.0.0.1", port: 8080 });
	});
	it("trims whitespace around host:port", () => {
		expect(parseBind("  localhost:8080  ")).toEqual({ hostname: "localhost", port: 8080 });
	});
	it("port 0 is valid", () => {
		expect(parseBind("0")).toEqual({ hostname: "127.0.0.1", port: 0 });
	});
	it("port 65535 is valid", () => {
		expect(parseBind("65535")).toEqual({ hostname: "127.0.0.1", port: 65535 });
	});
});

describe("parseBind errors", () => {
	it("throws on empty string", () => {
		expect(() => parseBind("")).toThrow(ConfigurationError);
	});
	it("throws on whitespace-only string", () => {
		expect(() => parseBind("   ")).toThrow(ConfigurationError);
	});
	it("throws on missing port", () => {
		expect(() => parseBind("localhost:")).toThrow(ConfigurationError);
	});
	it("throws on missing host", () => {
		expect(() => parseBind(":8080")).toThrow(ConfigurationError);
	});
	it("throws on non-numeric port", () => {
		expect(() => parseBind("localhost:abc")).toThrow(ConfigurationError);
	});
	it("throws on port out of range (negative)", () => {
		expect(() => parseBind("-1")).toThrow(ConfigurationError);
	});
	it("throws on port out of range (>65535)", () => {
		expect(() => parseBind("65536")).toThrow(ConfigurationError);
	});
	it("throws on port with decimal", () => {
		expect(() => parseBind("80.5")).toThrow(ConfigurationError);
	});
	it("throws on missing colon and non-numeric", () => {
		expect(() => parseBind("localhost")).toThrow(ConfigurationError);
	});
	it("throws on host:port with non-numeric port", () => {
		expect(() => parseBind("localhost:12abc")).toThrow(ConfigurationError);
	});
});
