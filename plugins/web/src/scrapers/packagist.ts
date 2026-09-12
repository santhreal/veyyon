import { packagistDeclaration } from "./declarations/package-registries";
import { createPackageRegistryHandler } from "./engine/package-registry";
import type { SpecialHandler } from "./types";

export const handlePackagist: SpecialHandler = createPackageRegistryHandler(packagistDeclaration, "handlePackagist");
