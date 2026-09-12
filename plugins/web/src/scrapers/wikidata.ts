import { wikidataDeclaration } from "./declarations/documentation";
import { createDocumentationHandler } from "./engine/documentation";
import type { SpecialHandler } from "./types";

export const handleWikidata: SpecialHandler = createDocumentationHandler(wikidataDeclaration, "handleWikidata");
