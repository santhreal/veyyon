/**
 * GET /api/events controller (Server-Sent Events).
 */
import type { ServerContext } from "../context";

export function getEventsController(ctx: ServerContext): Response {
	return ctx.sse.createResponse(ctx.store);
}
