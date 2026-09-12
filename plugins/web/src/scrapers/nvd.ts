import { nvdDeclaration } from "./declarations/security-advisories";
import { createSecurityAdvisoryHandler } from "./engine/security-advisory";
import type { SpecialHandler } from "./types";

export const handleNvd: SpecialHandler = createSecurityAdvisoryHandler(nvdDeclaration, "handleNvd");
