import { osvDeclaration } from "./declarations/security-advisories";
import { createSecurityAdvisoryHandler } from "./engine/security-advisory";
import type { SpecialHandler } from "./types";

export const handleOsv: SpecialHandler = createSecurityAdvisoryHandler(osvDeclaration, "handleOsv");
