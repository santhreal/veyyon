/**
 * Differential oracle: inspect-image-main-renderer from origin/main.
 * Source SHA: 90ac7c1e589ad3ca068f7b95da560839f469b9bb
 */
import { type LegacyRenderer, loadHistoricalOracle } from "./historical-loader";

const oracle = loadHistoricalOracle("inspect-image-main-renderer");

export const inspectImageToolRenderer = oracle.inspectImageToolRenderer as LegacyRenderer;
