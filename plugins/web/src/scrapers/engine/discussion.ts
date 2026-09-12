import type { SpecialHandler } from "../types";
import type { DeclarativeContext, DeclarativeSite } from "./declarative";
import { createDeclarativeHandler } from "./declarative";

export interface DiscussionMatch {
	id: string;
	subpath?: string;
	site?: string;
	kind?: string;
	parsedUrl: URL;
}

export type DiscussionContext = DeclarativeContext;

export type DiscussionDeclaration = DeclarativeSite<DiscussionMatch>;

export function createDiscussionHandler(decl: DiscussionDeclaration, handlerName?: string): SpecialHandler {
	return createDeclarativeHandler(decl, handlerName, true);
}
