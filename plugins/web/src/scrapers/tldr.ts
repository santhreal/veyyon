import { tldrDeclaration } from "./declarations/documentation";
import { createDocumentationHandler } from "./engine/documentation";
import type { SpecialHandler } from "./types";

export const handleTldr: SpecialHandler = createDocumentationHandler(tldrDeclaration, "handleTldr");
