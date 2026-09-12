import { w3cDeclaration } from "./declarations/documentation";
import { createDocumentationHandler } from "./engine/documentation";
import type { SpecialHandler } from "./types";

export const handleW3c: SpecialHandler = createDocumentationHandler(w3cDeclaration, "handleW3c");
