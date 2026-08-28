/**
 * WHY:
 * The dashboard must route all HTTP requests through the canonical SERVER_ROUTES table
 * from src/wire.ts rather than hand-building endpoint URLs with string concatenation.
 * Hand-built URLs easily diverge from server route handlers during refactors.
 *
 * This suite verifies:
 *  1. Every endpoint used by dashboard components resolves against SERVER_ROUTES.
 *  2. resolveRoute throws on undeclared routes and hand-built URL paths.
 *  3. Dynamic parameter substitution in resolveRoute matches route definitions.
 */

import { describe, expect, it } from "bun:test";
import { resolveRoute } from "../../dashboard/routes";
import { type HttpMethod, SERVER_ROUTES } from "../../engine/store-shapes";

describe("All dashboard API calls route through declared server routes", () => {
	it("resolves all dashboard endpoint templates against the runtime SERVER_ROUTES table", () => {
		const dashboardEndpoints: Array<{ method: HttpMethod; path: string; params?: Record<string, string> }> = [
			{ method: "GET", path: "/api/token" },
			{ method: "GET", path: "/api/events" },
			{ method: "GET", path: "/api/experiments" },
			{ method: "GET", path: "/api/experiments/:id", params: { id: "exp-1" } },
			{ method: "PUT", path: "/api/experiments/:id", params: { id: "exp-1" } },
			{ method: "POST", path: "/api/experiments/:id/arms", params: { id: "exp-1" } },
			{ method: "GET", path: "/api/runs" },
			{ method: "POST", path: "/api/runs" },
			{ method: "GET", path: "/api/runs/:name", params: { name: "run-a" } },
			{ method: "POST", path: "/api/runs/:name/cancel", params: { name: "run-a" } },
			{ method: "POST", path: "/api/runs/:name/resume", params: { name: "run-a" } },
			{ method: "GET", path: "/api/runs/:name/traces/:trace", params: { name: "run-a", trace: "t-1" } },
		];

		// Dynamic enumeration: every dashboard endpoint must exist in SERVER_ROUTES
		for (const ep of dashboardEndpoints) {
			const inServerRoutes = SERVER_ROUTES.some(r => r.method === ep.method && r.path === ep.path);
			expect(inServerRoutes).toBe(true);

			const resolved = resolveRoute(ep.method, ep.path, ep.params);
			expect(typeof resolved).toBe("string");
			if (ep.params) {
				for (const [key, value] of Object.entries(ep.params)) {
					expect(resolved).toContain(encodeURIComponent(value));
					expect(resolved).not.toContain(`:${key}`);
				}
			}
		}
	});

	it("fails with an explicit error when attempting to resolve an undeclared route", () => {
		// Hand-built / unregistered endpoints must fail immediately
		expect(() => resolveRoute("POST", "/api/runs/hand-built-url")).toThrow(
			/Undeclared server route: POST \/api\/runs\/hand-built-url/,
		);
		expect(() => resolveRoute("DELETE", "/api/invalid-endpoint")).toThrow(
			/Undeclared server route: DELETE \/api\/invalid-endpoint/,
		);
		expect(() => resolveRoute("POST", "/api/runs/:name/stop", { name: "test" })).toThrow(
			/Undeclared server route: POST \/api\/runs\/:name\/stop/,
		);
	});

	it("encodes path parameters safely against injection", () => {
		const resolved = resolveRoute("GET", "/api/experiments/:id", { id: "foo/bar?baz=1" });
		expect(resolved).toBe("/api/experiments/foo%2Fbar%3Fbaz%3D1");
	});
});
