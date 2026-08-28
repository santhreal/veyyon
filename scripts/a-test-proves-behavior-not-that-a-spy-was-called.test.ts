/**
 * Two fakes this repository has already been burned by, held down mechanically.
 *
 * `mock.module()` mutates the global module registry and leaks into every file
 * that runs after it (oven-sh/bun#12823), so a suite that passes alone poisons a
 * later one and the failure lands on innocent code.
 *
 * `expect(spy).toHaveBeenCalled()` asserts that a call happened, which is a claim
 * about wiring rather than about behavior. `review.md` has banned it since before
 * the account-manager defect, and that defect shipped anyway: the suite covering
 * it asserted a `showError` spy had fired while the error was painted over by a
 * fullscreen card, so it stayed green through the entire life of the bug. A guide
 * is not a gate, which is why this file exists.
 *
 * WHAT IT DOES NOT CATCH: the 398 files already holding 2407 of these assertions.
 * A blanket ban would be switched off within the week, so they are grandfathered
 * with exact counts. What is rejected is growth: a new test file with one, or one
 * more in a file that already has some. It also cannot judge whether a spy
 * assertion is the right call in a file that legitimately observes a callback —
 * it counts, and the count may only fall.
 *
 * The scan itself lives in `scripts/lib/spy-assertion-scan.ts` because the ledger
 * has to be produced by exactly the counting the gate applies. Two copies would
 * drift and the numbers would stop meaning anything.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { countSpyAssertions, stripCommentsAndStrings, testFiles, usesMockModule } from "./lib/spy-assertion-scan";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/** This file names both patterns in prose, so the scan is told to skip it. */
const SELF = "a-test-proves-behavior-not-that-a-spy-was-called.test.ts";

/**
 * Files holding spy-call assertions when this gate was written, with exact
 * counts. Shrink-only: fixing one lowers its number, emptying a file removes its
 * row, and nothing is ever added. There is deliberately no equivalent list for
 * `mock.module` — the scan found zero real callers, so that ban starts clean.
 */
const GRANDFATHERED: Readonly<Record<string, number>> = {
	"packages/agent/test/agent-side-request-context.test.ts": 1,
	"packages/agent/test/compaction-provider-boundary.test.ts": 2,
	"packages/agent/test/compaction-remote.test.ts": 1,
	"packages/agent/test/compaction-telemetry.test.ts": 4,
	"packages/agent/test/compaction-thinking-level.test.ts": 4,
	"packages/agent/test/handoff.test.ts": 3,
	"packages/agent/test/pause-abort-during-wait-does-not-enter-turn.test.ts": 2,
	"packages/ai/src/registry/oauth/__tests__/success-page.test.ts": 1,
	"packages/ai/src/registry/oauth/__tests__/xai-oauth.test.ts": 2,
	"packages/ai/test/alibaba-endpoint-selection.test.ts": 3,
	"packages/ai/test/anthropic-oauth.test.ts": 6,
	"packages/ai/test/anthropic-ping-keepalive.test.ts": 2,
	"packages/ai/test/anthropic-stream-timeout.test.ts": 6,
	"packages/ai/test/auth-broker-refresher.test.ts": 3,
	"packages/ai/test/auth-storage-broker-no-sentinel.test.ts": 2,
	"packages/ai/test/auth-storage-check-credentials.test.ts": 8,
	"packages/ai/test/auth-storage-codex-selection.test.ts": 1,
	"packages/ai/test/auth-storage-force-refresh-rotate.test.ts": 9,
	"packages/ai/test/auth-storage-oauth-account-select.test.ts": 1,
	"packages/ai/test/auth-storage-oauth-refresh-race.test.ts": 3,
	"packages/ai/test/auth-storage-sqlite-busy.test.ts": 2,
	"packages/ai/test/auth-storage-usage-cache.test.ts": 1,
	"packages/ai/test/azure-openai-responses-stream.test.ts": 4,
	"packages/ai/test/claude-usage-retry.test.ts": 3,
	"packages/ai/test/coreweave-login.test.ts": 2,
	"packages/ai/test/cursor-blob-miss-is-announced.test.ts": 1,
	"packages/ai/test/discarded-attempt-spend.test.ts": 1,
	"packages/ai/test/github-copilot-login.test.ts": 1,
	"packages/ai/test/gitlab-duo-workflow-oauth.test.ts": 2,
	"packages/ai/test/issue-2424-repro.test.ts": 1,
	"packages/ai/test/kilo-login.test.ts": 2,
	"packages/ai/test/nanogpt-login.test.ts": 1,
	"packages/ai/test/nous-research-oauth.test.ts": 1,
	"packages/ai/test/oauth-deepseek.test.ts": 3,
	"packages/ai/test/one-verdict-decides-whether-a-failed-response-is-sent-again.test.ts": 1,
	"packages/ai/test/openai-codex-stream.test.ts": 28,
	"packages/ai/test/openai-responses-cache-affinity.test.ts": 1,
	"packages/ai/test/openai-responses-openrouter.test.ts": 4,
	"packages/ai/test/provider-registry.test.ts": 1,
	"packages/ai/test/raw-sse-sdk-capture.test.ts": 1,
	"packages/ai/test/remote-auth-store.test.ts": 18,
	"packages/ai/test/synthetic-login.test.ts": 1,
	"packages/ai/test/umans-login.test.ts": 2,
	"packages/ai/test/xiaomi-oauth.test.ts": 3,
	"packages/ai/test/zenmux-login.test.ts": 1,
	"packages/ai/test/zhipu-coding-plan-login.test.ts": 1,
	"packages/catalog/test/github-copilot-model-limits.test.ts": 4,
	"packages/catalog/test/litellm-provider.test.ts": 2,
	"packages/catalog/test/modelsdev-overlay.test.ts": 2,
	"packages/catalog/test/nanogpt-model-limits.test.ts": 1,
	"packages/catalog/test/ollama-cloud-provider.test.ts": 1,
	"packages/catalog/test/sakana-provider.test.ts": 2,
	"packages/catalog/test/zenmux-provider.test.ts": 2,
	"packages/coding-agent/src/advisor/__tests__/advisor.test.ts": 10,
	"packages/coding-agent/src/eval/__tests__/agent-bridge.test.ts": 20,
	"packages/coding-agent/src/eval/__tests__/completion-bridge.test.ts": 1,
	"packages/coding-agent/src/hindsight/provider-boundary.test.ts": 2,
	"packages/coding-agent/src/internal-urls/__tests__/ssh-protocol.test.ts": 4,
	"packages/coding-agent/src/mcp/transports/stdio.test.ts": 1,
	"packages/coding-agent/src/modes/components/custom-editor.test.ts": 1,
	"packages/coding-agent/src/modes/controllers/extension-ui-controller.test.ts": 4,
	"packages/coding-agent/src/ssh/__tests__/file-transfer-posix-guard.test.ts": 2,
	"packages/coding-agent/src/system-prompt.test.ts": 2,
	"packages/coding-agent/test/a-failed-compaction-parks-the-run-instead-of-looping.test.ts": 21,
	"packages/coding-agent/test/a-superseded-prompt-stops-before-classifying-thinking.test.ts": 4,
	"packages/coding-agent/test/acp-builtins.test.ts": 10,
	"packages/coding-agent/test/agent-session-acp-permission.test.ts": 11,
	"packages/coding-agent/test/agent-session-auto-compaction-progress-guard.test.ts": 43,
	"packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts": 3,
	"packages/coding-agent/test/agent-session-before-agent-start-attribution.test.ts": 3,
	"packages/coding-agent/test/agent-session-btw-branch.test.ts": 1,
	"packages/coding-agent/test/agent-session-concurrent.test.ts": 7,
	"packages/coding-agent/test/agent-session-context-promotion.test.ts": 8,
	"packages/coding-agent/test/agent-session-eager-compaction.test.ts": 1,
	"packages/coding-agent/test/agent-session-goal-midrun-compaction.test.ts": 8,
	"packages/coding-agent/test/agent-session-handoff.test.ts": 18,
	"packages/coding-agent/test/agent-session-magic-keywords.test.ts": 1,
	"packages/coding-agent/test/agent-session-message-pipeline.test.ts": 7,
	"packages/coding-agent/test/agent-session-model-switch-auth.test.ts": 5,
	"packages/coding-agent/test/agent-session-openai-completions-model-switch.test.ts": 7,
	"packages/coding-agent/test/agent-session-openai-responses-replay.test.ts": 8,
	"packages/coding-agent/test/agent-session-persisted-keys-cache.test.ts": 1,
	"packages/coding-agent/test/agent-session-pre-compaction-pruning.test.ts": 2,
	"packages/coding-agent/test/agent-session-python-cleanup.test.ts": 25,
	"packages/coding-agent/test/agent-session-retry-cap.test.ts": 1,
	"packages/coding-agent/test/agent-session-retry-fallback.test.ts": 4,
	"packages/coding-agent/test/agent-session-role-thinking.test.ts": 7,
	"packages/coding-agent/test/agent-session-ssh-refresh.test.ts": 1,
	"packages/coding-agent/test/agent-session-steer-idle-drain.test.ts": 2,
	"packages/coding-agent/test/agent-session-todo-reminder-async-jobs.test.ts": 4,
	"packages/coding-agent/test/agent-session-todo-reminder-loop.test.ts": 5,
	"packages/coding-agent/test/agent-session-unexpected-stop-guard.test.ts": 7,
	"packages/coding-agent/test/agent-session-user-shortcut-hooks.test.ts": 6,
	"packages/coding-agent/test/agent-session-verification-evidence.test.ts": 3,
	"packages/coding-agent/test/agent-storage-credential-integrity.test.ts": 6,
	"packages/coding-agent/test/agents-slash-routing.test.ts": 5,
	"packages/coding-agent/test/ask-timeout.test.ts": 7,
	"packages/coding-agent/test/auto-compaction-refuses-an-unsendable-summary.test.ts": 2,
	"packages/coding-agent/test/autocomplete-max-visible.test.ts": 1,
	"packages/coding-agent/test/bash-acp-terminal.test.ts": 7,
	"packages/coding-agent/test/bash-executor.test.ts": 2,
	"packages/coding-agent/test/capability/fs-special-files.test.ts": 3,
	"packages/coding-agent/test/collab/guest-idle-reconciler.test.ts": 6,
	"packages/coding-agent/test/commit-command-exit.test.ts": 7,
	"packages/coding-agent/test/commit/parse-commit-args.test.ts": 3,
	"packages/coding-agent/test/compaction-auth-fallback.test.ts": 2,
	"packages/coding-agent/test/compaction-lifecycle.test.ts": 3,
	"packages/coding-agent/test/compaction-model-chain.test.ts": 2,
	"packages/coding-agent/test/compaction-prefer-current-model.test.ts": 5,
	"packages/coding-agent/test/compaction-provider-boundary.test.ts": 1,
	"packages/coding-agent/test/compaction-respects-provider-concurrency-cap.test.ts": 2,
	"packages/coding-agent/test/compaction.test.ts": 2,
	"packages/coding-agent/test/config-cli.test.ts": 2,
	"packages/coding-agent/test/config/config-value-command-failures.test.ts": 1,
	"packages/coding-agent/test/config/provider-globals.test.ts": 3,
	"packages/coding-agent/test/config/schema-render-failure-reporting.test.ts": 1,
	"packages/coding-agent/test/core/an-eval-backend-reaches-its-kernel-module-on-every-call.test.ts": 2,
	"packages/coding-agent/test/core/js-executor.test.ts": 3,
	"packages/coding-agent/test/core/js-tool-bridge.test.ts": 1,
	"packages/coding-agent/test/core/python-executor-owner-cleanup.test.ts": 39,
	"packages/coding-agent/test/countdown-timer.test.ts": 7,
	"packages/coding-agent/test/custom-editor-buffered-double-esc.test.ts": 3,
	"packages/coding-agent/test/custom-editor-keybindings.test.ts": 5,
	"packages/coding-agent/test/debug/dap-config.test.ts": 3,
	"packages/coding-agent/test/debug/dap-launch-failures.test.ts": 1,
	"packages/coding-agent/test/discovery/unreadable-dir.test.ts": 3,
	"packages/coding-agent/test/edit-acp-bridge.test.ts": 8,
	"packages/coding-agent/test/edit-auto-generated-regressions.test.ts": 2,
	"packages/coding-agent/test/empty-bracketed-paste.test.ts": 13,
	"packages/coding-agent/test/empty-submit-flushes-queued-messages.test.ts": 15,
	"packages/coding-agent/test/event-controller-abort-render.test.ts": 4,
	"packages/coding-agent/test/event-controller-error-banner.test.ts": 23,
	"packages/coding-agent/test/event-controller-todo-reminder.test.ts": 5,
	"packages/coding-agent/test/exa-mcp-tool-registration.test.ts": 1,
	"packages/coding-agent/test/extensibility/custom-commands/review.test.ts": 12,
	"packages/coding-agent/test/extensibility/legacy-pi-default-resource-loader.test.ts": 1,
	"packages/coding-agent/test/extensions-runner.test.ts": 9,
	"packages/coding-agent/test/git-metadata-reads-survive-eintr.test.ts": 1,
	"packages/coding-agent/test/goals/a-goal-is-never-unset-in-silence.test.ts": 3,
	"packages/coding-agent/test/goals/a-late-job-result-completes-its-interrupted-call.test.ts": 1,
	"packages/coding-agent/test/goals/goal-mode-integration.test.ts": 19,
	"packages/coding-agent/test/goals/goal-tool.test.ts": 5,
	"packages/coding-agent/test/goals/guided-goal.test.ts": 2,
	"packages/coding-agent/test/gran-1-subagent-durable-session.test.ts": 2,
	"packages/coding-agent/test/hindsight-backend.test.ts": 9,
	"packages/coding-agent/test/hindsight-bank.test.ts": 5,
	"packages/coding-agent/test/hook-editor.test.ts": 56,
	"packages/coding-agent/test/hook-input-timeout.test.ts": 19,
	"packages/coding-agent/test/image-paste.test.ts": 14,
	"packages/coding-agent/test/image-path-paste.test.ts": 9,
	"packages/coding-agent/test/input-controller-escape.test.ts": 96,
	"packages/coding-agent/test/input-controller-focused-submit-restore.test.ts": 4,
	"packages/coding-agent/test/input-controller-followup-image.test.ts": 6,
	"packages/coding-agent/test/input-controller-followup-paste-expansion.test.ts": 2,
	"packages/coding-agent/test/input-controller-goal-detail.test.ts": 5,
	"packages/coding-agent/test/input-controller-keybindings.test.ts": 33,
	"packages/coding-agent/test/input-controller-large-paste.test.ts": 9,
	"packages/coding-agent/test/input-controller-orphan-submit.test.ts": 9,
	"packages/coding-agent/test/input-controller-python-prefix.test.ts": 10,
	"packages/coding-agent/test/input-controller-skill-queue.test.ts": 15,
	"packages/coding-agent/test/input-controller-slash-history.test.ts": 22,
	"packages/coding-agent/test/input-controller-smart-paste.test.ts": 16,
	"packages/coding-agent/test/input-controller-suspend.test.ts": 20,
	"packages/coding-agent/test/input-controller-thinking-visibility.test.ts": 23,
	"packages/coding-agent/test/interactive-mcp-command.test.ts": 5,
	"packages/coding-agent/test/interactive-mode-editor-component.test.ts": 1,
	"packages/coding-agent/test/interactive-mode-loop.test.ts": 2,
	"packages/coding-agent/test/interactive-mode-lsp-startup.test.ts": 3,
	"packages/coding-agent/test/interactive-mode-mcp-connecting.test.ts": 3,
	"packages/coding-agent/test/interactive-mode-plan-review.test.ts": 46,
	"packages/coding-agent/test/interactive-mode-working-accent.test.ts": 11,
	"packages/coding-agent/test/internal-urls/issue-pr-protocol.test.ts": 12,
	"packages/coding-agent/test/internal-urls/vault-protocol.test.ts": 6,
	"packages/coding-agent/test/ipc-safe-send.test.ts": 2,
	"packages/coding-agent/test/irc/bus-traffic-log.test.ts": 2,
	"packages/coding-agent/test/job-poll-displacement.test.ts": 2,
	"packages/coding-agent/test/keybindings-escape-components.test.ts": 5,
	"packages/coding-agent/test/loop-limit.test.ts": 3,
	"packages/coding-agent/test/lsp-render.test.ts": 2,
	"packages/coding-agent/test/main-cross-project-resume.test.ts": 3,
	"packages/coding-agent/test/main-interactive-input.test.ts": 24,
	"packages/coding-agent/test/mcp-command-ignores-repo-config.test.ts": 8,
	"packages/coding-agent/test/mcp-command-reauth.test.ts": 13,
	"packages/coding-agent/test/mcp-command-toggle.test.ts": 8,
	"packages/coding-agent/test/mcp-manager-oauth-refresh.test.ts": 6,
	"packages/coding-agent/test/mcp-profile-auth-binding.test.ts": 5,
	"packages/coding-agent/test/mcp-timeout.test.ts": 2,
	"packages/coding-agent/test/mcp/a-credential-that-cannot-be-presented-is-not-sent-anonymously.test.ts": 1,
	"packages/coding-agent/test/mcp/server-response-delivery.test.ts": 1,
	"packages/coding-agent/test/memories-runtime.test.ts": 8,
	"packages/coding-agent/test/memories-storage.test.ts": 1,
	"packages/coding-agent/test/memory-tools.test.ts": 33,
	"packages/coding-agent/test/model-hub.test.ts": 25,
	"packages/coding-agent/test/model-picker.test.ts": 6,
	"packages/coding-agent/test/modes/components/agent-dashboard-age-ticker.test.ts": 4,
	"packages/coding-agent/test/modes/components/agent-dashboard-roster-order.test.ts": 4,
	"packages/coding-agent/test/modes/components/agent-transcript-viewer.test.ts": 1,
	"packages/coding-agent/test/modes/components/ask-dialog.test.ts": 55,
	"packages/coding-agent/test/modes/components/copy-selector.test.ts": 3,
	"packages/coding-agent/test/modes/components/custom-editor-bash-background-fallthrough.test.ts": 3,
	"packages/coding-agent/test/modes/components/plan-review-overlay.test.ts": 18,
	"packages/coding-agent/test/modes/components/plugin-list-marketplace.test.ts": 1,
	"packages/coding-agent/test/modes/components/the-extensions-dashboard-fades-both-its-bands.test.ts": 1,
	"packages/coding-agent/test/modes/components/the-login-card-answers-the-pointer.test.ts": 5,
	"packages/coding-agent/test/modes/components/the-login-screen-is-one-frame.test.ts": 2,
	"packages/coding-agent/test/modes/components/the-model-cards-fade-every-band-they-own.test.ts": 1,
	"packages/coding-agent/test/modes/components/the-plugins-tab-answers-the-pointer.test.ts": 2,
	"packages/coding-agent/test/modes/components/the-transcript-card-answers-the-pointer.test.ts": 6,
	"packages/coding-agent/test/modes/components/tool-execution-background-task.test.ts": 2,
	"packages/coding-agent/test/modes/components/tool-execution-spinner.test.ts": 12,
	"packages/coding-agent/test/modes/components/welcome.test.ts": 1,
	"packages/coding-agent/test/modes/context-usage.test.ts": 10,
	"packages/coding-agent/test/modes/controllers/a-closed-settings-card-lets-go-of-the-clock.test.ts": 1,
	"packages/coding-agent/test/modes/controllers/a-command-login-lands-in-the-account-manager.test.ts": 3,
	"packages/coding-agent/test/modes/controllers/a-dismissed-picker-lets-go-of-the-clock.test.ts": 7,
	"packages/coding-agent/test/modes/controllers/a-toast-is-for-an-unanswered-question.test.ts": 2,
	"packages/coding-agent/test/modes/controllers/adding-an-account-comes-back-to-the-card.test.ts": 1,
	"packages/coding-agent/test/modes/controllers/an-overlay-does-not-repaint-the-world.test.ts": 4,
	"packages/coding-agent/test/modes/controllers/bash-command.test.ts": 1,
	"packages/coding-agent/test/modes/controllers/btw-controller.test.ts": 14,
	"packages/coding-agent/test/modes/controllers/event-controller-abort-guard.test.ts": 6,
	"packages/coding-agent/test/modes/controllers/event-controller-cwd-changed-reroot.test.ts": 2,
	"packages/coding-agent/test/modes/controllers/event-controller-idle-compaction.test.ts": 8,
	"packages/coding-agent/test/modes/controllers/event-controller-interrupt.test.ts": 3,
	"packages/coding-agent/test/modes/controllers/event-controller-loader-recovery.test.ts": 7,
	"packages/coding-agent/test/modes/controllers/event-controller-message-start.test.ts": 13,
	"packages/coding-agent/test/modes/controllers/event-controller-message-update-repaint.test.ts": 4,
	"packages/coding-agent/test/modes/controllers/event-controller-superseded-agent-end.test.ts": 3,
	"packages/coding-agent/test/modes/controllers/event-controller-todo-never-ran.test.ts": 7,
	"packages/coding-agent/test/modes/controllers/event-controller-toolcall-finalize.test.ts": 3,
	"packages/coding-agent/test/modes/controllers/handoff-command.test.ts": 4,
	"packages/coding-agent/test/modes/controllers/input-controller-tool-expansion.test.ts": 5,
	"packages/coding-agent/test/modes/controllers/move-command.test.ts": 7,
	"packages/coding-agent/test/modes/controllers/omfg-controller.test.ts": 7,
	"packages/coding-agent/test/modes/controllers/selector-controller-login.test.ts": 7,
	"packages/coding-agent/test/modes/controllers/selector-controller-logout.test.ts": 1,
	"packages/coding-agent/test/modes/controllers/selector-controller-overlay-focus.test.ts": 7,
	"packages/coding-agent/test/modes/controllers/selector-prompt-gate-rebuild.test.ts": 10,
	"packages/coding-agent/test/modes/controllers/session-selector-delete.test.ts": 5,
	"packages/coding-agent/test/modes/controllers/tan-command-controller.test.ts": 22,
	"packages/coding-agent/test/modes/controllers/the-second-account-is-named-when-it-lands.test.ts": 6,
	"packages/coding-agent/test/modes/controllers/todo-command-controller.test.ts": 26,
	"packages/coding-agent/test/modes/controllers/usage-command.test.ts": 3,
	"packages/coding-agent/test/modes/cwd-change-refreshes-system-prompt.test.ts": 1,
	"packages/coding-agent/test/modes/setup-wizard-onboarding-scope.test.ts": 1,
	"packages/coding-agent/test/modes/utils/render-initial-messages.test.ts": 5,
	"packages/coding-agent/test/oauth-flow.test.ts": 4,
	"packages/coding-agent/test/optimistic-submission-survives-prestream-rebuild.test.ts": 5,
	"packages/coding-agent/test/phase1-stage1-failures-are-logged.test.ts": 1,
	"packages/coding-agent/test/plan-mode-pending-model-switch-leak.test.ts": 2,
	"packages/coding-agent/test/plugin-install-local.test.ts": 6,
	"packages/coding-agent/test/print-mode-secret-command.test.ts": 2,
	"packages/coding-agent/test/profile-cli.test.ts": 6,
	"packages/coding-agent/test/read-acp-fs.test.ts": 1,
	"packages/coding-agent/test/registry/agent-lifecycle.test.ts": 1,
	"packages/coding-agent/test/repro-issue-2600-shutdown-timeout.test.ts": 3,
	"packages/coding-agent/test/sdk-credential-disabled-bridge.test.ts": 2,
	"packages/coding-agent/test/sdk-mcp-auto-discovery.test.ts": 3,
	"packages/coding-agent/test/sdk-model-selection.test.ts": 2,
	"packages/coding-agent/test/secrets/a-spend-is-visible-in-every-approval-mode.test.ts": 5,
	"packages/coding-agent/test/secrets/masked-secret-entry.test.ts": 4,
	"packages/coding-agent/test/secrets/secret-runtime-lifecycle.test.ts": 2,
	"packages/coding-agent/test/secrets/stalevaultneverrefuses-the-expansion-lease-reloads-before-it-refuses.test.ts": 7,
	"packages/coding-agent/test/selector-controller-overlay-close.test.ts": 4,
	"packages/coding-agent/test/selector-settings-side-effects.test.ts": 11,
	"packages/coding-agent/test/session-focus-controller.test.ts": 1,
	"packages/coding-agent/test/session-manager/build-context.test.ts": 1,
	"packages/coding-agent/test/session-manager/tree-traversal.test.ts": 1,
	"packages/coding-agent/test/session-storage.test.ts": 1,
	"packages/coding-agent/test/session/detached-abort.test.ts": 2,
	"packages/coding-agent/test/session/rescope-to-cwd.test.ts": 6,
	"packages/coding-agent/test/session/subagent-rescope-isolation.test.ts": 1,
	"packages/coding-agent/test/setup-wizard-sign-in.test.ts": 7,
	"packages/coding-agent/test/setup-wizard-viewport.test.ts": 2,
	"packages/coding-agent/test/setup-wizard.test.ts": 2,
	"packages/coding-agent/test/shake-mid-stream-preserves-turn.test.ts": 1,
	"packages/coding-agent/test/shake.test.ts": 2,
	"packages/coding-agent/test/silent-abort-print-mode.test.ts": 3,
	"packages/coding-agent/test/slash-commands/a-slash-command-refuses-an-option-spelling-it-no-longer-has.test.ts": 14,
	"packages/coding-agent/test/slash-commands/bare-command-opens-a-picker.test.ts": 6,
	"packages/coding-agent/test/slash-commands/btw.test.ts": 5,
	"packages/coding-agent/test/slash-commands/client-surface-parity.test.ts": 5,
	"packages/coding-agent/test/slash-commands/collab-qrcode.test.ts": 3,
	"packages/coding-agent/test/slash-commands/compact.test.ts": 12,
	"packages/coding-agent/test/slash-commands/copy.test.ts": 11,
	"packages/coding-agent/test/slash-commands/cwd.test.ts": 2,
	"packages/coding-agent/test/slash-commands/debug.test.ts": 3,
	"packages/coding-agent/test/slash-commands/force.test.ts": 16,
	"packages/coding-agent/test/slash-commands/fresh.test.ts": 2,
	"packages/coding-agent/test/slash-commands/memory.test.ts": 3,
	"packages/coding-agent/test/slash-commands/move.test.ts": 5,
	"packages/coding-agent/test/slash-commands/omfg.test.ts": 5,
	"packages/coding-agent/test/slash-commands/plan-history.test.ts": 3,
	"packages/coding-agent/test/slash-commands/rename.test.ts": 5,
	"packages/coding-agent/test/slash-commands/resume.test.ts": 14,
	"packages/coding-agent/test/slash-commands/retry.test.ts": 6,
	"packages/coding-agent/test/slash-commands/session.test.ts": 11,
	"packages/coding-agent/test/slash-commands/setup.test.ts": 12,
	"packages/coding-agent/test/slash-commands/shake.test.ts": 8,
	"packages/coding-agent/test/slash-commands/statusline.test.ts": 4,
	"packages/coding-agent/test/slash-commands/switch.test.ts": 3,
	"packages/coding-agent/test/slash-commands/tan.test.ts": 5,
	"packages/coding-agent/test/slash-commands/thinking.test.ts": 5,
	"packages/coding-agent/test/slash-commands/yolo.test.ts": 17,
	"packages/coding-agent/test/status-line-dispose-async-leak.test.ts": 3,
	"packages/coding-agent/test/status-line-pr-lookup-timeout.test.ts": 1,
	"packages/coding-agent/test/status-line-settings-cache.test.ts": 6,
	"packages/coding-agent/test/streaming-edit-abort.test.ts": 5,
	"packages/coding-agent/test/streaming-reveal.test.ts": 3,
	"packages/coding-agent/test/stt-preflight.test.ts": 7,
	"packages/coding-agent/test/stt-submit-trigger.test.ts": 8,
	"packages/coding-agent/test/subagent-hud-render.test.ts": 2,
	"packages/coding-agent/test/tailrev-auto-compaction-failure-rolls-back-elision.test.ts": 2,
	"packages/coding-agent/test/task-label-provider-boundary.test.ts": 3,
	"packages/coding-agent/test/task/autoload-skill-resolution-scope.test.ts": 3,
	"packages/coding-agent/test/task/autoload-skills.test.ts": 5,
	"packages/coding-agent/test/task/create-memo.test.ts": 3,
	"packages/coding-agent/test/task/delegation-policy-boundaries.test.ts": 1,
	"packages/coding-agent/test/task/executor-pass-through.test.ts": 1,
	"packages/coding-agent/test/task/executor-subagent-reminders.test.ts": 9,
	"packages/coding-agent/test/task/executor-yield-versus-caller-abort.test.ts": 1,
	"packages/coding-agent/test/task/isolation-runner.test.ts": 10,
	"packages/coding-agent/test/task/spawn-agents-md-reaches-the-child-prompt.test.ts": 1,
	"packages/coding-agent/test/task/spawn-cwd-layer-inheritance.test.ts": 1,
	"packages/coding-agent/test/task/subagent-inherits-approval-bypass.test.ts": 1,
	"packages/coding-agent/test/task/task-spawn.test.ts": 3,
	"packages/coding-agent/test/task/worktree.test.ts": 5,
	"packages/coding-agent/test/theme-auto-detection.test.ts": 7,
	"packages/coding-agent/test/tiny-title-generator.test.ts": 11,
	"packages/coding-agent/test/title-generator-no-title.test.ts": 2,
	"packages/coding-agent/test/title-generator.test.ts": 11,
	"packages/coding-agent/test/tool-args-reveal.test.ts": 4,
	"packages/coding-agent/test/tool-execution-args.test.ts": 1,
	"packages/coding-agent/test/tool-execution-memoization.test.ts": 8,
	"packages/coding-agent/test/tool-execution-ssh-repaint.test.ts": 5,
	"packages/coding-agent/test/tool-execution-write-repaint.test.ts": 4,
	"packages/coding-agent/test/tools/apply-patch-renderer.test.ts": 1,
	"packages/coding-agent/test/tools/ask.test.ts": 28,
	"packages/coding-agent/test/tools/browser-dispose-timeout.test.ts": 2,
	"packages/coding-agent/test/tools/browser-lifecycle-leak.test.ts": 4,
	"packages/coding-agent/test/tools/eval-fallback.test.ts": 6,
	"packages/coding-agent/test/tools/fetch-binary-dispatch.test.ts": 1,
	"packages/coding-agent/test/tools/fetch-kagi-toggle.test.ts": 13,
	"packages/coding-agent/test/tools/fetch-raw-mode.test.ts": 1,
	"packages/coding-agent/test/tools/gh.test.ts": 18,
	"packages/coding-agent/test/tools/github-cache.test.ts": 17,
	"packages/coding-agent/test/tools/grep-internal-urls.test.ts": 1,
	"packages/coding-agent/test/tools/irc.test.ts": 5,
	"packages/coding-agent/test/tools/lsp-batching.test.ts": 6,
	"packages/coding-agent/test/tools/lsp-diagnostics-freshness.test.ts": 5,
	"packages/coding-agent/test/tools/lsp-regressions.test.ts": 20,
	"packages/coding-agent/test/tools/provider-network-confidentiality.test.ts": 3,
	"packages/coding-agent/test/tools/read-pdf-images.test.ts": 3,
	"packages/coding-agent/test/tools/read-pdf-line-range.test.ts": 1,
	"packages/coding-agent/test/tools/report-tool-issue.test.ts": 10,
	"packages/coding-agent/test/tools/search-url-paths.test.ts": 4,
	"packages/coding-agent/test/tools/ssh-description.test.ts": 4,
	"packages/coding-agent/test/tools/ssh-url-ungated-tools.test.ts": 2,
	"packages/coding-agent/test/tools/task-async-fallback.test.ts": 3,
	"packages/coding-agent/test/tools/tool-output-spill-threshold-has-one-owner.test.ts": 2,
	"packages/coding-agent/test/tools/web-scrapers/youtube-parallel.test.ts": 1,
	"packages/coding-agent/test/tools/web-search-xai.test.ts": 1,
	"packages/coding-agent/test/tui/a-tool-blocks-rail-moves-while-it-runs-and-cools-once-it-lands.test.ts": 4,
	"packages/coding-agent/test/unexpected-stop-provider-boundary.test.ts": 2,
	"packages/coding-agent/test/update-cli-install-release-e2e.test.ts": 1,
	"packages/coding-agent/test/update-cli.test.ts": 12,
	"packages/coding-agent/test/utils/archive-path-containment.test.ts": 1,
	"packages/coding-agent/test/utils/clipboard.test.ts": 11,
	"packages/coding-agent/test/utils/markit-cache.test.ts": 4,
	"packages/coding-agent/test/utils/open.test.ts": 3,
	"packages/coding-agent/test/vibe/vibe-runtime.test.ts": 3,
	"packages/coding-agent/test/web/search/abort-and-timeout.test.ts": 6,
	"packages/coding-agent/test/web/search/codex-broker.test.ts": 2,
	"packages/coding-agent/test/write-acp-fs.test.ts": 5,
	"packages/coding-agent/test/write-streaming-preview-expand.test.ts": 2,
	"packages/mnemopi/test/beam-store.test.ts": 1,
	"packages/mnemopi/test/consolidate-fact-id-collision.test.ts": 1,
	"packages/mnemopi/test/consolidate-fact-sibling-races.test.ts": 1,
	"packages/mnemopi/test/embedding-failure-logging.test.ts": 4,
	"packages/mnemopi/test/extraction-wiring.test.ts": 1,
	"packages/mnemopi/test/fastembed-model-cache.test.ts": 1,
	"packages/mnemopi/test/optional-embeddings.test.ts": 1,
	"packages/mnemopi/test/streaming.test.ts": 1,
	"packages/mnemopi/test/veracity-one-vocabulary.test.ts": 4,
	"packages/stats/test/smoke-worker-darwin.test.ts": 1,
	"packages/stats/test/sync-serial.test.ts": 3,
	"packages/swarm-extension/src/swarm/__tests__/executor.test.ts": 1,
	"packages/tool-render/test/theme-toggle.test.tsx": 1,
	"packages/tui/test/desktop-notify.test.ts": 4,
	"packages/tui/test/loader.test.ts": 25,
	"packages/tui/test/loop-watchdog-wiring.test.ts": 2,
	"packages/tui/test/loop-watchdog.test.ts": 13,
	"packages/tui/test/notifications-respect-window-focus.test.ts": 4,
	"packages/tui/test/notifications.test.ts": 4,
	"packages/utils/test/eval-prompts-override-replaces-registry-text.test.ts": 2,
	"packages/utils/test/fault-sink.test.ts": 5,
	"packages/utils/test/frontmatter.test.ts": 3,
	"packages/utils/test/fs-optional-strict-twins.test.ts": 3,
	"packages/utils/test/issue-935-repro.test.ts": 1,
};

/** Path as the ledger spells it: repo-relative, forward slashes, every platform. */
function key(file: string): string {
	return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

/** Every scanned test file paired with the count the gate reads from it. */
function counts(): Map<string, number> {
	const found = new Map<string, number>();
	for (const file of testFiles(REPO_ROOT, SELF)) {
		const total = countSpyAssertions(fs.readFileSync(file, "utf8"));
		if (total > 0) found.set(key(file), total);
	}
	return found;
}

describe("a test proves behavior, not that a spy was called", () => {
	/**
	 * The hard ban. No allowlist, because there is nothing to grandfather: every
	 * apparent user is a doc comment or a fixture inside a template literal, and
	 * the scan sees through both. A real call turns this red on the first run.
	 */
	it("never calls mock.module, which leaks across every later file", () => {
		const callers = testFiles(REPO_ROOT, SELF)
			.filter(file => usesMockModule(fs.readFileSync(file, "utf8")))
			.map(file => key(file));

		expect(callers).toEqual([]);
	});

	/**
	 * Fail-by-default. A test file that is not in the ledger may hold none, so a
	 * new file carrying one — or an old file that starts carrying one — is red
	 * until someone either drops the assertion or records the decision.
	 */
	it("adds no spy-call assertion to a file that had none", () => {
		const offenders = [...counts().keys()].filter(file => !(file in GRANDFATHERED)).sort();

		expect(offenders).toEqual([]);
	});

	/**
	 * And no file grows. Exact equality rather than an upper bound: a row that
	 * says twelve where five remain is a number nobody can trust, and the failure
	 * names the value to write.
	 */
	it("keeps every grandfathered count exactly where the ledger says", () => {
		const found = counts();
		const actual = Object.fromEntries(Object.keys(GRANDFATHERED).map(file => [file, found.get(file) ?? 0]));

		expect(actual).toEqual(GRANDFATHERED);
	});

	/** A row for a file that no longer exists hides a count nobody is holding. */
	it("names a real file in every ledger row", () => {
		const missing = Object.keys(GRANDFATHERED).filter(file => !fs.existsSync(path.join(REPO_ROOT, file)));

		expect(missing).toEqual([]);
	});

	/**
	 * The scan's own contract, asserted rather than assumed. A scanner that
	 * reports violations nobody can fix is a scanner somebody deletes, and every
	 * case below is one this repository actually contains.
	 */
	describe("the scan reads code, not prose", () => {
		it("ignores a pattern named in a line or block comment", () => {
			const source = [
				"// never write expect(spy).toHaveBeenCalled()",
				"/* and mock.module( is banned */",
				"ok();",
			].join("\n");

			expect(countSpyAssertions(source)).toBe(0);
			expect(usesMockModule(source)).toBe(false);
		});

		it("ignores a fixture embedded in a template literal", () => {
			const source = ["const fixture = `", "  mock.module('x', () => ({}));", "`;"].join("\n");

			expect(usesMockModule(source)).toBe(false);
		});

		it("still sees a real call, including inside an interpolation", () => {
			expect(countSpyAssertions("expect(spy).toHaveBeenCalledWith(1);")).toBe(1);
			expect(usesMockModule("mock.module('x', () => ({}));")).toBe(true);
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the `${...}` is the scanned fixture's own bytes — an interpolation the scanner must read as code.
			expect(usesMockModule("const s = `${mock.module('x', () => ({}))}`;")).toBe(true);
		});

		it("counts each occurrence, so a second one in a file is growth", () => {
			const source = ["expect(a).toHaveBeenCalled();", "expect(b).toHaveBeenCalledTimes(2);"].join("\n");

			expect(countSpyAssertions(source)).toBe(2);
		});

		/**
		 * An escaped quote must not end the string early. Without this the scanner
		 * falls out of the string mid-body and reads the rest of a fixture as code.
		 */
		it("does not leave a string on an escaped quote", () => {
			expect(usesMockModule('const s = "he said \\"mock.module(\\" and stopped";')).toBe(false);
		});

		/** Positions stay put, so a line number reported against the strip is the file's. */
		it("preserves length and line structure", () => {
			const source = "const a = 1; // comment\nconst b = `text`;\n";
			const stripped = stripCommentsAndStrings(source);

			expect(stripped.length).toBe(source.length);
			expect(stripped.split("\n").length).toBe(source.split("\n").length);
		});
	});
});
