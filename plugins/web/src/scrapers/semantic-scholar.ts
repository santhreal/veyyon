import { semanticScholarDeclaration } from "./declarations/academic-papers";
import { createAcademicPaperHandler } from "./engine/academic-paper";
import type { SpecialHandler } from "./types";

export const handleSemanticScholar: SpecialHandler = createAcademicPaperHandler(
	semanticScholarDeclaration,
	"handleSemanticScholar",
);
