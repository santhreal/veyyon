import { hexDeclaration } from "./declarations/package-registries";
import { createPackageRegistryHandler } from "./engine/package-registry";
import type { SpecialHandler } from "./types";

export const handleHex: SpecialHandler = createPackageRegistryHandler(hexDeclaration, "handleHex");
