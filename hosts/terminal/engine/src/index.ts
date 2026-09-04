// The terminal renderer and the component tree it paints.
//
// Everything this barrel reaches either performs I/O on a terminal device or is a
// component that renders into one. The string processing that used to live here —
// width math, ANSI and SGR rewriting, key parsing, LaTeX conversion, motion curves,
// fuzzy matching, paint encoding — is in `@veyyon/utils`, imported from there
// directly. This barrel re-exports none of it: a consumer that needs `visibleWidth`
// depends on string math, not on a renderer, and the import should say so.

// Components
export * from "./components/box";
export * from "./components/cancellable-loader";
export * from "./components/editor";
// Editor component interface (for custom editors)
export type * from "./components/editor-component";
export * from "./components/image";
export * from "./components/input";
export * from "./components/loader";
export * from "./components/markdown";
export * from "./components/scroll-view";
export * from "./components/select-list";
export * from "./components/settings-list";
export * from "./components/settings-search";
export * from "./components/spacer";
export * from "./components/tab-bar";
export * from "./components/text";
export * from "./components/truncated-text";
// Desktop notifications via D-Bus (Linux freedesktop notifications)
export * from "./desktop-notify";
// Input buffering for batch splitting
export * from "./stdin-buffer";
// Terminal interface and implementations
export * from "./terminal";
// Terminal capability probing (image protocols, DECCARA, hyperlinks)
export * from "./terminal-capabilities";
export * from "./tui";
// Terminal window focus (DECSET 1004), read by the notification gate
export * from "./window-focus";
