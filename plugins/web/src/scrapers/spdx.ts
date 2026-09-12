import { spdxDeclaration } from "./declarations/documentation";
import { createDocumentationHandler } from "./engine/documentation";
import type { SpecialHandler } from "./types";

export const handleSpdx: SpecialHandler = createDocumentationHandler(spdxDeclaration, "handleSpdx");
