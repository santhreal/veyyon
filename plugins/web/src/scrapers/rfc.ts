import { rfcDeclaration } from "./declarations/academic-papers";
import { createAcademicPaperHandler } from "./engine/academic-paper";
import type { SpecialHandler } from "./types";

export const handleRfc: SpecialHandler = createAcademicPaperHandler(rfcDeclaration, "handleRfc");
