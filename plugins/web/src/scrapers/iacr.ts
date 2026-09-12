import { iacrDeclaration } from "./declarations/academic-papers";
import { createAcademicPaperHandler } from "./engine/academic-paper";
import type { SpecialHandler } from "./types";

export const handleIacr: SpecialHandler = createAcademicPaperHandler(iacrDeclaration, "handleIacr");
