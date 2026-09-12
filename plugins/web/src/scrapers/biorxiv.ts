import { biorxivDeclaration } from "./declarations/academic-papers";
import { createAcademicPaperHandler } from "./engine/academic-paper";
import type { SpecialHandler } from "./types";

export const handleBiorxiv: SpecialHandler = createAcademicPaperHandler(biorxivDeclaration, "handleBiorxiv");
