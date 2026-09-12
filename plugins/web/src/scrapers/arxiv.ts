import { arxivDeclaration } from "./declarations/academic-papers";
import { createAcademicPaperHandler } from "./engine/academic-paper";
import type { SpecialHandler } from "./types";

export const handleArxiv: SpecialHandler = createAcademicPaperHandler(arxivDeclaration, "handleArxiv");
