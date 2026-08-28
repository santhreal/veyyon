/**
 * Local host shell for collab-web. The shared renderers are `./lib`.
 */

export * from "./element";
export * from "./lib";
// `./standalone` is deliberately NOT re-exported: it is the side-effecting
// entry point of the embedded tool-view bundle (importing it registers the
// `<vey-tool-view>` custom element), and pulling it in through the barrel
// would run that registration for every barrel consumer — including non-DOM
// environments like the bun test runner, where `customElements` is undefined.
