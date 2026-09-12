import { aurDeclaration } from "./declarations/package-registries";
import { createPackageRegistryHandler } from "./engine/package-registry";
import type { SpecialHandler } from "./types";

export const handleAur: SpecialHandler = createPackageRegistryHandler(aurDeclaration, "handleAur");
