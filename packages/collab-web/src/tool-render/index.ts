/**
 * Local host shell for collab-web. Shared renderers live in `@veyyon/tool-render`.
 */
export * from "@veyyon/tool-render";
export * from "./element";
// `./standalone` is deliberately NOT re-exported: it is the side-effecting
// entry point of the embedded tool-view bundle (importing it registers the
// `<vey-tool-view>` custom element), and pulling it in through the barrel
// would run that registration for every barrel consumer — including non-DOM
// environments like the bun test runner, where `customElements` is undefined.
