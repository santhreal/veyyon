import { metacpanDeclaration } from "./declarations/package-registries";
import { createPackageRegistryHandler } from "./engine/package-registry";
import type { SpecialHandler } from "./types";

export const handleMetaCPAN: SpecialHandler = createPackageRegistryHandler(metacpanDeclaration, "handleMetaCPAN");
