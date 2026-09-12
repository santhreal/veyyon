import { coingeckoDeclaration } from "./declarations/business";
import { createBusinessHandler } from "./engine/business";
import type { SpecialHandler } from "./types";

export const handleCoinGecko: SpecialHandler = createBusinessHandler(coingeckoDeclaration, "handleCoinGecko");
