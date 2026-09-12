import { crossrefDeclaration } from "./declarations/academic-papers";
import { createAcademicPaperHandler } from "./engine/academic-paper";
import type { SpecialHandler } from "./types";

export const handleCrossref: SpecialHandler = createAcademicPaperHandler(crossrefDeclaration, "handleCrossref");
