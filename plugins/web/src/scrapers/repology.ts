import { repologyDeclaration } from "./declarations/package-registries";
import { createPackageRegistryHandler } from "./engine/package-registry";
import type { SpecialHandler } from "./types";

export const handleRepology: SpecialHandler = createPackageRegistryHandler(repologyDeclaration, "handleRepology");
