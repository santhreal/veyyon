/**
 * Request router and dispatch table for evals manager server.
 *
 * Derives route matching from the canonical SERVER_ROUTES table in src/wire.ts,
 * checks loopback authentication on mutating requests, and maps route handlers to responses.
 */
import { errorMessage } from "@veyyon/utils";
import { requirePathSegment } from "../engine/package-paths";
import { type HttpMethod, PATH_SEGMENT_PARAMS, type RouteDescriptor, SERVER_ROUTES } from "../engine/store-shapes";
import type { ServerContext } from "./context";
import { getBenchmarksController } from "./controllers/benchmarks";
import { getEventsController } from "./controllers/events";
import {
	addArmController,
	createExperimentController,
	deleteExperimentController,
	getExperimentDetailController,
	getExperimentsController,
	updateExperimentMetaController,
} from "./controllers/experiments";
import {
	cancelRunController,
	deleteRunController,
	getRunDetailController,
	getRunsController,
	launchRunController,
	resumeRunController,
} from "./controllers/runs";
import { getTokenController } from "./controllers/token";
import { getTraceDetailController } from "./controllers/traces";

export type RouteHandler = (
	ctx: ServerContext,
	url: URL,
	params: Record<string, string>,
	request: Request,
) => Promise<Response> | Response;

export function sanitizeErrorMessage(err: unknown, jobsDir?: string): string {
	let msg = errorMessage(err);
	if (jobsDir) {
		msg = msg.replaceAll(jobsDir, "<jobsDir>");
	}
	// Redact absolute POSIX filesystem paths (/a/b/c)
	msg = msg.replace(/(?:\/[a-zA-Z0-9._-]+){2,}/g, "<path>");
	// Redact Windows absolute filesystem paths (C:\a\b)
	msg = msg.replace(/[a-zA-Z]:\\(?:[a-zA-Z0-9._-]+\\?)+/g, "<path>");
	return msg;
}

export const ROUTE_HANDLERS: Record<string, RouteHandler> = {
	"GET /api/token": ctx => getTokenController(ctx),
	"GET /api/events": ctx => getEventsController(ctx),
	"GET /api/benchmarks": ctx => getBenchmarksController(ctx),
	"GET /api/experiments": (ctx, url) => getExperimentsController(ctx, url),
	"POST /api/experiments": (ctx, url, params, req) => createExperimentController(ctx, url, params, req),
	"GET /api/experiments/:id": (ctx, url, params) => getExperimentDetailController(ctx, url, params),
	"PUT /api/experiments/:id": (ctx, url, params, req) => updateExperimentMetaController(ctx, url, params, req),
	"DELETE /api/experiments/:id": (ctx, url, params) => deleteExperimentController(ctx, url, params),
	"POST /api/experiments/:id/arms": (ctx, url, params, req) => addArmController(ctx, url, params, req),
	"GET /api/runs": (ctx, url) => getRunsController(ctx, url),
	"POST /api/runs": (ctx, url, params, req) => launchRunController(ctx, url, params, req),
	"GET /api/runs/:name": (ctx, url, params) => getRunDetailController(ctx, url, params),
	"DELETE /api/runs/:name": (ctx, url, params) => deleteRunController(ctx, url, params),
	"POST /api/runs/:name/cancel": (ctx, url, params) => cancelRunController(ctx, url, params),
	"POST /api/runs/:name/resume": (ctx, url, params, req) => resumeRunController(ctx, url, params, req),
	"GET /api/runs/:name/traces/:trace": (ctx, url, params) => getTraceDetailController(ctx, url, params),
};

interface CompiledRoute {
	readonly method: HttpMethod;
	readonly path: string;
	readonly regex: RegExp;
	readonly paramNames: string[];
	readonly handler: RouteHandler;
}

export function compileRoutes(
	routes: readonly RouteDescriptor[] = SERVER_ROUTES,
	handlers: Record<string, RouteHandler> = ROUTE_HANDLERS,
): CompiledRoute[] {
	const compiled: CompiledRoute[] = [];
	for (const desc of routes) {
		const key = `${desc.method} ${desc.path}`;
		const handler = handlers[key];
		if (!handler) continue;

		const paramNames: string[] = [];
		const regexPattern = desc.path.replace(/:([a-zA-Z0-9_]+)/g, (_, name: string) => {
			paramNames.push(name);
			return "([^/]+)";
		});
		compiled.push({
			method: desc.method,
			path: desc.path,
			regex: new RegExp(`^${regexPattern}$`),
			paramNames,
			handler,
		});
	}
	return compiled;
}

export class RequestRouter {
	readonly #compiledRoutes: readonly CompiledRoute[];

	constructor(
		routes: readonly RouteDescriptor[] = SERVER_ROUTES,
		handlers: Record<string, RouteHandler> = ROUTE_HANDLERS,
	) {
		this.#compiledRoutes = compileRoutes(routes, handlers);
	}

	async dispatch(ctx: ServerContext, request: Request): Promise<Response> {
		const url = new URL(request.url);
		const pathname = url.pathname;
		const method = request.method.toUpperCase();

		try {
			if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
				const authHeader = request.headers.get("authorization") ?? "";
				const tokenHeader = request.headers.get("x-evals-token") ?? "";
				const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
				const providedToken = (
					bearerMatch ? bearerMatch[1] : tokenHeader || url.searchParams.get("token") || ""
				).trim();
				if (!providedToken || providedToken !== ctx.token) {
					return Response.json(
						{ error: "unauthorized: valid token required for mutating requests" },
						{ status: 401 },
					);
				}
			}

			for (const route of this.#compiledRoutes) {
				if (route.method !== method) continue;
				const match = pathname.match(route.regex);
				if (!match) continue;

				const params: Record<string, string> = {};
				for (let i = 0; i < route.paramNames.length; i++) {
					const name = route.paramNames[i] as string;
					// Decoded, so `%2e%2e%2f` is a separator by the time a handler sees it. A parameter
					// that names a directory is checked here, once, rather than by each controller that
					// joins it: a run name reached `path.join`, a kill and an `fs.rmSync` unchecked.
					const value = decodeURIComponent(match[i + 1] as string);
					params[name] = PATH_SEGMENT_PARAMS.includes(name)
						? requirePathSegment(value, `${name} parameter`)
						: value;
				}
				return await route.handler(ctx, url, params, request);
			}

			return Response.json({ error: "not found" }, { status: 404 });
		} catch (err) {
			const message = sanitizeErrorMessage(err, ctx.jobsDir);
			return Response.json({ error: message }, { status: 400 });
		}
	}
}
