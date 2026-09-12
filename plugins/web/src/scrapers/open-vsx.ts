import { openVsxDeclaration } from "./declarations/package-registries";
import { createPackageRegistryHandler } from "./engine/package-registry";
import type { SpecialHandler } from "./types";

export const handleOpenVsx: SpecialHandler = createPackageRegistryHandler(openVsxDeclaration, "handleOpenVsx");
