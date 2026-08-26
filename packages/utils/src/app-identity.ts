/**
 * Product name constants: `APP_DIRECTORY_SLUG` for filesystem paths and `APP_DISPLAY_NAME` for display.
 * Distinguishing the slug from the display name prevents silent collisions. Leaf module with no imports.
 */

/** The lowercase slug used in filesystem paths: config, cache and data directories. */
export const APP_DIRECTORY_SLUG = "veyyon";

/**
 * The capitalized name a person reads: desktop notification titles, the OSC 99 application field, and the
 * built-in provider's display name.
 */
export const APP_DISPLAY_NAME = "Veyyon";
