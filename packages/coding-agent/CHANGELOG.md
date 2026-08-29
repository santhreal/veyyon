# Changelog

## [Unreleased]

### Changed
- Free functions, consts, and types extracted from `markit/converters/epub.ts`, `provider-boundary.ts`, `modes/components/modal-select-list.ts`, `modes/setup-wizard/scenes/glyph.ts`, `modes/components/extensions/inspector-panel.ts`, and `modes/controllers/ssh-command-controller.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `modes/rpc/rpc-mode.ts`, `modes/controllers/todo-command-controller.ts`, `extensibility/extensions/wrapper.ts`, `session/tool-choice-queue.ts`, `markit/converters/xlsx.ts`, `modes/components/login-dialog.ts`, `advisor/emission-guard.ts`, and `session/session-loader.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `tools/browser.ts`, `hindsight/state.ts`, `tools/irc.ts`, `modes/controllers/omfg-controller.ts`, `modes/components/model-picker.ts`, `modes/theme/theme-class.ts`, and `modes/components/chat-transcript-builder.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `edit/match.ts`, `task/agents.ts`, `tools/output-meta.ts`, `modes/components/tree-selector.ts`, `modes/components/transcript-note.ts`, `tools/checkpoint.ts`, and `extensibility/extensions/loader.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `web/kagi.ts` and `web/search/providers/kagi.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `async/job-manager.ts`, `web/parallel.ts`, `tts/tts-client.ts`, `modes/components/extensions/extension-dashboard.ts`, `registry/agent-registry.ts`, and `tts/streaming-player.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `debug/debug-selector.ts`, `modes/components/mcp-add-wizard.ts`, and `modes/controllers/event-controller.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `modes/components/plan-review-overlay.ts`, `modes/components/account-manager.ts`, and `collab/host.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `markit/converters/pptx.ts` and `autoresearch/storage.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `hindsight/client.ts`, `mcp/smithery-registry.ts`, and `tools/glob.ts` into companion `*-helpers.ts` files.
- `runRpcMode` command dispatch extracted into `executeRpcCommand` function with `RpcCommandContext` interface, reducing `handleCommand` from 363 lines to a 3-line wrapper.
- Free functions, consts, and types extracted from `export/ttsr.ts` into companion `export/ttsr-helpers.ts`.
- Free functions, consts, and types extracted from `irc/bus.ts`, `modes/components/pause-screen.ts`, `modes/controllers/extension-ui-controller.ts`, and `session/agent-storage.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `modes/components/settings-submenus/rules-submenu.ts`, `modes/components/settings-submenus/compaction-submenu.ts`, `modes/components/compaction-summary-message.ts`, `modes/components/rollback-picker.ts`, `modes/setup-wizard/scenes/sign-in.ts`, and `session/operator-notices.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `extensibility/plugins/marketplace/manager.ts`, `lsp/clients/swiftlint-client.ts`, `modes/components/cache-invalidation-marker.ts`, `modes/components/settings-submenus/model-roles-submenu.ts`, and `extensibility/utils.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `modes/interactive/working-loader-manager.ts`, `modes/interactive/goal-mode-controller.ts`, `utils/image-loading.ts`, `goals/tools/goal-tool.ts`, and `session/redis-session-storage.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `modes/components/copy-selector.ts`, `tools/vibe.ts`, `task/parallel.ts`, `config/config-file.ts`, and `debug/raw-sse.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `tools/job.ts`, `stt/asr-client.ts`, and `tools/set-cwd.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `eval/jl/kernel.ts`, `eval/rb/kernel.ts`, and `internal-urls/artifact-protocol.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `modes/components/hook-selector.ts`, `vibe/runtime.ts`, `web/search/providers/parallel.ts`, `eval/py/kernel.ts`, and `collab/guest.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `modes/rpc/host-tools.ts`, `extensibility/custom-commands/bundled/ci-green/index.ts`, and `argot-wire.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `modes/components/tiny-title-download-progress.ts`, `secrets/regex.ts`, `mcp/tool-cache.ts`, `registry/agent-lifecycle.ts`, `mnemopi/embed-client.ts`, and `session/session-entry-index.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `security/project-trust.ts`, `jsonrpc/message-framing.ts`, `session/write-accounting.ts`, `tools/memory-retain.ts`, `modes/controllers/streaming-reveal.ts`, `modes/controllers/tool-args-reveal.ts`, and `mcp/transports/http.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `modes/components/assistant-message.ts`, `modes/setup-wizard/wizard-overlay.ts`, `modes/components/transcript-container.ts`, `modes/components/plugin-settings.ts`, and `debug/log-viewer.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `session/indexed-session-storage.ts` and `eval/js/worker-core.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `session/indexed-session-storage.ts` and `eval/js/worker-core.ts` into companion `*-helpers.ts` files.
