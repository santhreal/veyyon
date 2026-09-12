import { pubmedDeclaration } from "./declarations/academic-papers";
import { createAcademicPaperHandler } from "./engine/academic-paper";
import type { SpecialHandler } from "./types";

export const handlePubMed: SpecialHandler = createAcademicPaperHandler(pubmedDeclaration, "handlePubMed");
