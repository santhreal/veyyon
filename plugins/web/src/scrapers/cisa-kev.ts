import { cisaKevDeclaration } from "./declarations/security-advisories";
import { createSecurityAdvisoryHandler } from "./engine/security-advisory";
import type { SpecialHandler } from "./types";

export const handleCisaKev: SpecialHandler = createSecurityAdvisoryHandler(cisaKevDeclaration, "handleCisaKev");
