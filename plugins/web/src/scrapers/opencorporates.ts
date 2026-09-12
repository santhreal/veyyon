import { type CompanyData, opencorporatesDeclaration, renderCompanyInfoTable } from "./declarations/business";
import { createBusinessHandler } from "./engine/business";
import type { SpecialHandler } from "./types";

export type { CompanyData };
export { renderCompanyInfoTable };
export const handleOpenCorporates: SpecialHandler = createBusinessHandler(
	opencorporatesDeclaration,
	"handleOpenCorporates",
);
