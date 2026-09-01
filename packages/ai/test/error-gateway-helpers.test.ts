import { describe, expect, it } from "bun:test";
import { classifyGatewayError } from "../src/error/gateway";

describe("classifyGatewayError", () => {
	it("classifies 401 status as authentication_error", () => {
		const result = classifyGatewayError({ status: 401, message: "unauthorized" });
		expect(result.status).toBe(401);
		expect(result.type).toBe("authentication_error");
	});
	it("classifies 403 status as authentication_error", () => {
		const result = classifyGatewayError({ status: 403, message: "forbidden" });
		expect(result.status).toBe(403);
		expect(result.type).toBe("authentication_error");
	});
	it("classifies 429 status as rate_limit_error", () => {
		const result = classifyGatewayError({ status: 429, message: "rate limited" });
		expect(result.status).toBe(429);
		expect(result.type).toBe("rate_limit_error");
	});
	it("classifies 400 status as invalid_request_error", () => {
		const result = classifyGatewayError({ status: 400, message: "bad request" });
		expect(result.status).toBe(400);
		expect(result.type).toBe("invalid_request_error");
	});
	it("classifies 404 status as invalid_request_error", () => {
		const result = classifyGatewayError({ status: 404, message: "not found" });
		expect(result.status).toBe(404);
		expect(result.type).toBe("invalid_request_error");
	});
	it("classifies 500 status as upstream_error", () => {
		const result = classifyGatewayError({ status: 500, message: "internal error" });
		expect(result.status).toBe(500);
		expect(result.type).toBe("upstream_error");
	});
	it("classifies 502 status as upstream_error", () => {
		const result = classifyGatewayError({ status: 502, message: "bad gateway" });
		expect(result.status).toBe(502);
		expect(result.type).toBe("upstream_error");
	});
	it("classifies abort error as 499", () => {
		const err = new Error("aborted");
		err.name = "AbortError";
		const result = classifyGatewayError(err);
		expect(result.status).toBe(499);
		expect(result.type).toBe("request_aborted");
	});
	it("classifies 'aborted' in message as 499", () => {
		const result = classifyGatewayError(new Error("request was aborted"));
		expect(result.status).toBe(499);
		expect(result.type).toBe("request_aborted");
	});
	it("classifies 'rate limit' in message as 429", () => {
		const result = classifyGatewayError(new Error("rate limit exceeded"));
		expect(result.status).toBe(429);
		expect(result.type).toBe("rate_limit_error");
	});
	it("classifies 'too many requests' in message as 429", () => {
		const result = classifyGatewayError(new Error("too many requests"));
		expect(result.status).toBe(429);
		expect(result.type).toBe("rate_limit_error");
	});
	it("classifies 'quota exceeded' in message as 429", () => {
		const result = classifyGatewayError(new Error("quota exceeded"));
		expect(result.status).toBe(429);
		expect(result.type).toBe("rate_limit_error");
	});
	it("classifies 'unauthorized' in message as 401", () => {
		const result = classifyGatewayError(new Error("unauthorized access"));
		expect(result.status).toBe(401);
		expect(result.type).toBe("authentication_error");
	});
	it("classifies 'forbidden' in message as 401", () => {
		const result = classifyGatewayError(new Error("forbidden resource"));
		expect(result.status).toBe(401);
		expect(result.type).toBe("authentication_error");
	});
	it("classifies 'bad request' in message as 400", () => {
		const result = classifyGatewayError(new Error("bad request format"));
		expect(result.status).toBe(400);
		expect(result.type).toBe("invalid_request_error");
	});
	it("classifies 'malformed' in message as 400", () => {
		const result = classifyGatewayError(new Error("malformed input"));
		expect(result.status).toBe(400);
		expect(result.type).toBe("invalid_request_error");
	});
	it("classifies unknown error as 502 upstream_error", () => {
		const result = classifyGatewayError(new Error("something went wrong"));
		expect(result.status).toBe(502);
		expect(result.type).toBe("upstream_error");
	});
	it("extracts embedded HTTP status from message", () => {
		const result = classifyGatewayError(new Error("HTTP 503 Service Unavailable"));
		expect(result.status).toBe(503);
		expect(result.type).toBe("upstream_error");
	});
	it("extracts embedded status from 'API error: 429'", () => {
		const result = classifyGatewayError(new Error("API error: 429"));
		expect(result.status).toBe(429);
		expect(result.type).toBe("rate_limit_error");
	});
	it("extracts embedded status from '(404)'", () => {
		const result = classifyGatewayError(new Error("error (404)"));
		expect(result.status).toBe(404);
		expect(result.type).toBe("invalid_request_error");
	});
	it("classifies string error", () => {
		const result = classifyGatewayError("some string error");
		expect(result.status).toBe(502);
		expect(result.type).toBe("upstream_error");
	});
});
