import { rubygemsDeclaration } from "./declarations/package-registries";
import { createPackageRegistryHandler } from "./engine/package-registry";
import type { SpecialHandler } from "./types";

export const handleRubyGems: SpecialHandler = createPackageRegistryHandler(rubygemsDeclaration, "handleRubyGems");
