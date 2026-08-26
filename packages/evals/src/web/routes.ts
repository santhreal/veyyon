import { type HttpMethod, SERVER_ROUTES } from "../wire";

/**
 * Resolves a server route path by looking up the declared RouteDescriptor in SERVER_ROUTES
 * and replacing path parameters (`:param`).
 */
export function resolveRoute(method: HttpMethod, template: string, params: Record<string, string> = {}): string {
	const descriptor = SERVER_ROUTES.find(r => r.method === method && r.path === template);
	if (!descriptor) {
		throw new Error(`Undeclared server route: ${method} ${template}`);
	}
	let path: string = descriptor.path;
	for (const [key, value] of Object.entries(params)) {
		path = path.replace(`:${key}`, encodeURIComponent(value));
	}
	return path;
}
