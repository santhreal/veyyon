import { chocolateyDeclaration } from "./declarations/package-registries";
import { createPackageRegistryHandler } from "./engine/package-registry";
import type { SpecialHandler } from "./types";

export const handleChocolatey: SpecialHandler = createPackageRegistryHandler(chocolateyDeclaration, "handleChocolatey");
