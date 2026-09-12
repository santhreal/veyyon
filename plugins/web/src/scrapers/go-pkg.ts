import { goPkgDeclaration } from "./declarations/package-registries";
import { createPackageRegistryHandler } from "./engine/package-registry";
import type { SpecialHandler } from "./types";

export const handleGoPkg: SpecialHandler = createPackageRegistryHandler(goPkgDeclaration, "handleGoPkg");
