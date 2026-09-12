import type { SpecialHandler } from "../types";
import type { DeclarativeContext, DeclarativeSite } from "./declarative";
import { createDeclarativeHandler } from "./declarative";

export interface SecurityMatch {
	id: string;
	parsedUrl: URL;
}

export type SecurityContext = DeclarativeContext;

export type SecurityAdvisoryDeclaration = DeclarativeSite<SecurityMatch>;

export function createSecurityAdvisoryHandler(decl: SecurityAdvisoryDeclaration, handlerName?: string): SpecialHandler {
	return createDeclarativeHandler(decl, handlerName);
}
