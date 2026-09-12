import type { SpecialHandler } from "../types";
import type { DeclarativeContext, DeclarativeSite } from "./declarative";
import { createDeclarativeHandler } from "./declarative";

export interface MediaMatch {
	id: string;
	kind?: string;
	parsedUrl: URL;
}

export type MediaContext = DeclarativeContext;

export type MediaDeclaration = DeclarativeSite<MediaMatch>;

export function createMediaHandler(decl: MediaDeclaration, handlerName?: string): SpecialHandler {
	return createDeclarativeHandler(decl, handlerName);
}
