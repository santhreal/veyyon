import { buildMarkdownTableFromHtmlRows, mdnDeclaration } from "./declarations/documentation";
import { createDocumentationHandler } from "./engine/documentation";
import type { SpecialHandler } from "./types";

export { buildMarkdownTableFromHtmlRows };

export const handleMDN: SpecialHandler = createDocumentationHandler(mdnDeclaration, "handleMDN");
