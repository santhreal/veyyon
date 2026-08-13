# Changelog

## [Unreleased]

## [16.5.2] - 2026-07-14

### Fixed

- Fixed OpenCode Zen and Go discovery to replace stale bundled models with each provider's live model catalog.

## [16.5.1] - 2026-07-14

### Fixed

- Fixed reasoning effort mapping for Z.ai GLM-5.2 on the Anthropic messages endpoint to correctly use the two-tier scale (high, max) and emit output_config.effort.
- Fixed an issue where stale cached model limits would override updated static catalog limits after a catalog fingerprint mismatch.
- Fixed Cursor discovery to correctly preserve GetUsableModels max-mode metadata for premium models and invalidate stale cache entries.

## [16.4.3] - 2026-07-11

### Fixed

- Fixed parsing of SAP AI Core Claude model IDs in version-first format (e.g., anthropic--claude-4.8-opus), restoring adaptive thinking metadata and capability gates.
- Fixed GitHub Copilot Business and Enterprise model discovery to correctly preserve vision capabilities instead of downgrading models to text-only.

## [16.4.2] - 2026-07-10

### Fixed

- Fixed OpenAI Codex model discovery to include the Codex version header alongside the client_version query parameter.

## [16.4.1] - 2026-07-10

### Added

- Added GPT-5.6 Luna, Sol, and Terra models
- Added perplexity-academic-researcher model

### Changed

- Updated context windows for multiple GPT-5.6 models
- Increased max tokens for several models
- Updated cache write costs for GPT-5.6 variants
- Reduced pricing for select models

### Removed

- Removed the generated GPT-5.6 pro-reasoning aliases (`gpt-5.6-{luna,sol,terra}-pro`) from the `openai-codex` subscription provider — pro reasoning is not offered on subscriptions; the `openai` API-key aliases remain

## [16.4.0] - 2026-07-10

### Breaking Changes

- Redesigned reasoning effort ladders to be wire-exact, removing the shifted five-tier effort mapping. Models now expose exactly the effort tiers their upstream APIs accept, mapped 1:1. Removed SHIFTED_FIVE_TIER_EFFORT_MAP, ANTHROPIC_ADAPTIVE_EFFORT_MAP_4_TIER, and per-host xhigh-to-max alias maps. Selecting an unsupported tier now automatically clamps down via clampThinkingLevelForModel. Devin effort routing is now mapped 1:1 onto per-tier siblings.

### Added

- Added support for new models: Grok 4.5 family, Dolphin Mistral 24b Venice Edition, GLM5.2-Fast, and Zenmux variants for GPT-5.6 (Luna, Sol, and Terra).
- Added Novita as a model provider, including public catalog discovery, pricing, limits, modality, reasoning, and tool metadata.
- Added useResponsesLite to Model and ModelSpec to support the Responses Lite transport, enabled by default for the GPT-5.6 family.
- Added Effort.Max ("max") as a first-class user-facing thinking level above xhigh.

### Changed

- Enabled reasoning effort controls for Grok 4.5 and updated support flags for additional Grok variants
- Standardized reasoning effort levels to use a wire-exact max tier across all model providers, including Devin routing and Ollama configurations.
- Updated costs and context windows for various models in the catalog.

## [16.3.15] - 2026-07-09

### Added

- Added support for Grok 4.5 model
- Added `gpt-5.6` base models and `gpt-5.6-{luna,sol,terra}-pro` variants
- Added `meta/muse-spark-1.1` model support
- Added support for thinking modes on `poolside/laguna` models
- Added generated GPT-5.6 Pro aliases (`gpt-5.6-{luna,sol,terra}-pro`) on the `openai` and `openai-codex` providers: each alias sends the base model id on the wire (`requestModelId`) with the new `reasoningMode: "pro"` marker, and re-derives from the current base rows on every catalog regeneration.

### Changed

- Updated cache read costs for Grok models
- Reduced max token limit for Grok 4.3 model
- Enabled prompt cache affinity for Grok models via the x-grok-conv-id header in OpenAI compatible endpoints
- Enabled prompt cache affinity for Grok models via the x-grok-conv-id header
- Marked direct xAI Grok Chat Completions models for `x-grok-conv-id` prompt-cache affinity.

## [16.3.14] - 2026-07-09

### Added

- Added support for GPT-5.6 (Luna, Sol, Terra) model variants
- Enabled expanded five-tier reasoning effort scale (minimal to xhigh) for GPT-5.6 models
- Added GPT-5.6 (Terra/Luna/Sol) support for the new `max` reasoning tier: on wire-effort APIs (OpenAI Responses, Codex, Azure, openai-compat/OpenRouter models that advertise reasoning) user efforts shift up one notch — `xhigh` sends `max`, `high` sends `xhigh` — mirroring the Claude Fable/Opus 4.7+ five-tier mapping, and the exposed ladder becomes `minimal..xhigh` with `minimal` reaching the native `low` tier. Devin's per-tier GPT-5.6 sibling rows now collapse into `gpt-5-6-{luna,sol,terra}` logical models with the same shifted routing (`xhigh` → `-max`), plus `-fast` families that keep the direct `low..xhigh` `-priority` scale since Devin serves no `-max-priority` tier.

## [16.3.13] - 2026-07-09

### Added

- Added support for Grok 4.5 across multiple providers
- Added support for GPT-5.6 series models (Luna, Sol, Terra)
- Added Aion 3.0 and 3.0 Mini models
- Added Kuaishou KAT-Coder v2.5 models
- Added Nex-N2-Mini and SWE-1.7 series models
- Added Hy3 models and free variants

### Changed

- Updated cost and token configurations for various models across providers
- Renamed several models for consistency (e.g., MiniMax M3, Gemma 4 31B, Qwen variants)

## [16.3.12] - 2026-07-08

### Fixed

- Fixed LiteLLM discovery stopping at `/model_group/info` when that endpoint omitted `supports_vision`; it now continues to `/model/info` and preserves `model_info.supports_vision=true` for vision-capable proxy models. ([#4747](https://github.com/can1357/oh-my-pi/issues/4747))
- Fixed LiteLLM discovery to fall back to bundled catalog metadata when `models.dev` lacks a model reference, preserving reasoning and thinking support for models such as `glm-5.2`. ([#4695](https://github.com/can1357/oh-my-pi/issues/4695))
- Detected Azure AI Inference / Foundry Anthropic routes as strict-tool-incompatible so resolved Anthropic compat disables strict tools before request construction ([#4679](https://github.com/can1357/oh-my-pi/issues/4679)).

## [16.3.11] - 2026-07-06

### Added

- Added Claude Haiku 4.5 (JP) model support
- Added tencent/hy3 model support via ZenMux

### Changed

- Updated naming format for various synthetic models to include provider prefix
- Adjusted context window limit for MiniMax-M3 model
- Updated pricing for select models

## [16.3.10] - 2026-07-06

### Fixed

- Fixed LiteLLM rich discovery to ignore unusable sentinel placeholders and continue to `/v2/model/info` for real models. ([#4655](https://github.com/can1357/oh-my-pi/issues/4655))

## [16.3.9] - 2026-07-06

### Fixed

- Fixed compatibility with OpenCode Go DeepSeek V4 models by sending max_tokens instead of max_completion_tokens to match the provider's API requirements.

## [16.3.7] - 2026-07-05

### Fixed

- Fixed usage cost calculation to correctly account for provider orchestration token sidecars without misclassifying them as standard input, output, or cache tokens.

## [16.3.4] - 2026-07-03

### Added

- Added Baseten as a supported model provider
- Added support for new models from Baseten, including DeepSeek V4 Pro and Kimi series
- Added new Devin agent models: Claude 5 Fable variants
- Added new Github Copilot models: Kimi K2.7 Code and MAI-Code-1-Flash
- Added Poolside Laguna XS 2.1 models via Kilo and OpenRouter providers
- Added support for Claude Fable 5 (Free) via Zenmux provider

### Changed

- Updated priority ordering to include Baseten
- Updated pricing and limits for various existing models in the catalog

## [16.3.3] - 2026-07-02

### Fixed

- Extended Anthropic-compatible signing-endpoint recognition to Cloudflare AI Gateway, Google Vertex, AWS Bedrock, and Azure AI Inference / Foundry to ensure consistent reasoning-replay and signature-stripping behavior, and exposed ResolvedAnthropicCompat.signingEndpoint in the public API.
- Fixed Zhipu Coding Plan runtime discovery to prioritize account-scoped model lists over bundled fallback models, preventing routing errors for valid non-z.ai keys.

## [16.3.2] - 2026-07-02

### Fixed

- Fixed ZenMux model discovery to run without a `ZENMUX_API_KEY`, so newly published ZenMux models (for example `anthropic/claude-fable-5-free`) auto-update into the runtime `models.db` cache instead of waiting on a regenerated `models.json`.
- Fixed ZenMux runtime discovery to query the `/api/v1/models` endpoint even when the resolved provider base URL points at the Anthropic-compatible route, so discovery no longer requests a non-existent `/api/anthropic/models` path.

## [16.3.1] - 2026-07-02

### Removed

- Removed reasoning suppression prompt logic for GPT-5 models

## [16.3.0] - 2026-07-02

### Breaking Changes

- Renamed the `requiresJuiceZeroHack` compatibility flag to `requiresReasoningSuppressionPrompt` (affecting `OpenAICompat` and `ResolvedOpenAIResponsesCompat`) and removed the unused `"juice-zero-developer-message"` member from `OpenAIReasoningDisableMode`.

### Fixed

- Fixed stream markup healing pattern misfires by disabling the healer on the official OpenAI endpoint.
- Updated the Xiaomi provider's default model to the supported `mimo-v2.5` model.
- Fixed model discovery probes (including Ollama and metadata fetches) failing behind private-CA gateways by ensuring they honor the `NODE_EXTRA_CA_CERTS` environment variable.
- Fixed CoreWeave Serverless Inference project-header detection to ensure blank OpenAI-Project overrides do not block the `COREWEAVE_PROJECT` fallback.
- Fixed LiteLLM MiniMax M3 discovery to remove reseller-only display suffixes and invalidated the model cache to clear stale suffixes immediately.
- Fixed ZenMux's `anthropic-messages` proxy being misclassified as a non-signing reasoning endpoint (`replayUnsignedThinking: true`), matching the GitHub Copilot fix (#2851). ZenMux's `zenmux.ai/api/anthropic` route forwards to signature-enforcing Anthropic, so replaying a stripped/unsigned historical `thinking` block as `signature: ""` — most visibly an end_turn-bound checkpoint/branch-return turn whose signature the transform must strip — caused `400 messages.1.content.0: Invalid signature in thinking` on Claude Sonnet 5 and other reasoning models. ([#4192](https://github.com/can1357/oh-my-pi/issues/4192))

## [16.2.13] - 2026-07-01

### Added

- Added support for human-readable reasoning summaries on compatible OpenAI Codex models (v5.4+)

### Fixed

- Fixed discovered OpenAI Codex models to advertise V2 streaming remote compaction, avoiding the legacy compact endpoint timeout path for Codex sessions. ([#4146](https://github.com/can1357/oh-my-pi/issues/4146))

## [16.2.12] - 2026-07-01

### Breaking Changes

- Removed runtime canonical-equivalence APIs from the identity module, including resolveCanonicalVariant, buildCanonicalModelOrder, CanonicalVariantPreferences, and getBundledCanonicalReferenceData. These utilities have been transitioned to a build-time generator script and are no longer exposed in the runtime bundle.

## [16.2.11] - 2026-07-01

### Fixed

- Fixed a potential memory leak caused by dangling timeout timers during model discovery in OpenAI-compatible, vLLM, LiteLLM, and LM Studio catalogs.
- Widened stream watchdogs for local OpenAI-compatible backends (including llama.cpp, LM Studio, vLLM, and Ollama) to prevent premature timeouts during cold model loads.

## [16.2.10] - 2026-06-30

### Added

- Added Claude Sonnet 3.7, Claude Opus 3, and Claude Sonnet 3 model entries to the Anthropic catalog
- Added Anthropic Claude Sonnet 5 model entry to the Kilo provider catalog
- Added first-party catalog discovery support for the Anthropic provider
- Added Gemini 3.1 Flash Lite Image model entry to the Kilo provider catalog
- Added Anthropic Claude Sonnet 5 model variants with low, medium, high, xhigh, and max thinking efforts to the Devin provider catalog
- Added Claude Sonnet 5 model entry to the Anthropic curated catalog.

### Changed

- Updated the base API URL for the Claude Sonnet 5 model in the Anthropic catalog
- Updated pricing metrics for DeepSeek R1 and DeepSeek V3 model entries to reflect new rates

## [16.2.9] - 2026-06-30

### Added

- Added full capability support for Claude Sonnet 5, aligning it with Claude Opus 4.8 and Fable 5. This includes adaptive thinking display, mid-conversation system messages, sampling parameter and thinking omission API restrictions, and 5-tier adaptive reasoning effort mapping (including xhigh and max levels) across direct APIs, OpenRouter, and Bedrock Converse.

### Changed

- Updated input and output costs for models in the catalog.

## [16.2.7] - 2026-06-30

### Fixed

- Fixed compatibility with Kimi K2.7 Code on native endpoints to ensure thinking mode is preserved and tool choice is not forced.
- Fixed Cerebras gemma-4-31b dynamic discovery to correctly identify the model as image-capable, enabling proper serialization of attached images.

## [16.2.6] - 2026-06-29

### Fixed

- Fixed namespaced GLM-5.x model IDs on Z.AI/Zhipu OpenAI-compatible endpoints to inherit the widened stream watchdog, avoiding spurious stalled-stream errors during long thinking phases. ([#3819](https://github.com/can1357/oh-my-pi/issues/3819))

## [16.2.3] - 2026-06-28

### Added

- Added support and configuration parameters for V2 streaming compaction in RemoteCompactionConfig, catalog types, and model/provider metadata.

### Changed

- Enabled automatic content markup healing for all OpenAI-compatible streaming models
- Updated pricing and context window limits for several catalog models.
- Disabled reasoning capability for multiple providers in the catalog.

## [16.2.2] - 2026-06-27

### Removed

- Removed 'pi' from the list of supported dialects.

## [16.2.0] - 2026-06-27

### Added

- Added GitLab Duo Agent catalog discovery, including namespace selection, live model mapping, and a bundled fallback model for fresh installs.
- Added OpenAICompat.supportsNamedToolChoice to support forced tool use on string-only OpenAI-compatible chat servers without emitting the named function-object tool_choice shape.
- Added model metadata support for provider-native remote compaction and compaction-only model selection.

### Changed

- Disabled the thinking-effort selector for GitLab Duo Agent models since the underlying platform parameters are server-fixed.

### Fixed

- Improved GitLab Duo Agent and Duo Workflow namespace and project discovery to robustly handle paginated groups, SSH remotes with custom ports, Git worktrees, self-managed GitLab instances with relative paths, and configuration via GITLAB_DUO_PROJECT_PATH or GITLAB_DUO_PROJECT_ID.
- Fixed built-in LiteLLM discovery to prefer rich proxy metadata from management endpoints and avoid caching stale capability data.
- Fixed GitLab Duo Workflow model specifications to resolve correct static context windows, enabling accurate context usage tracking and auto-compaction.

## [16.1.23] - 2026-06-26

### Added

- Added `OpenAICompat.qwenPreserveThinking` — auto-enabled when the resolved `thinkingFormat` is `"qwen"` or `"qwen-chat-template"` AND `replayReasoningContent` is on (i.e. the four built-in local OpenAI-compatible providers, or a custom provider pointed at a loopback / RFC1918 / `*.local` baseUrl). Pairs with the chat-completions encoder change so the request body carries `preserve_thinking: true` (twin top-level + `chat_template_kwargs` emission), keeping Qwen3.6+ from stripping `<think>...</think>` off older assistant turns and breaking the local slot's KV cache between user messages. Non-Qwen chat templates ignore the parameter, so the flag stays a no-op outside the Qwen path; users on a cloud Qwen host (Alibaba Dashscope / Qwen Portal) can opt in with `compat.qwenPreserveThinking: true`. ([#3541](https://github.com/can1357/oh-my-pi/issues/3541))
- Added CoreWeave Serverless Inference as an OpenAI-compatible provider with models.dev-backed bundled catalog metadata.

## [16.1.22] - 2026-06-26

### Added

- Added `OpenAICompat.replayReasoningContent` — auto-enabled for the built-in local OpenAI-compatible providers (`llama.cpp`, `lm-studio`, `vllm`, `ollama` on `openai-completions`) and for any provider pointed at a loopback / RFC1918 / `*.local` baseUrl. NOT gated on `spec.reasoning`: the runtime discovery paths for `llama.cpp` / `lm-studio` / `openai-models-list` hardcode `reasoning: false` because the upstream `/models` endpoints don't advertise the capability, while the stream parser still records incoming `reasoning_content` deltas as thinking blocks — gating on the spec flag would leave every discovered local Qwen / DeepSeek model re-triggering #3528. The encoder only writes `reasoning_content` when a thinking block actually exists on the turn, so the flag is a no-op on pure-text histories. Built-in proxy providers (currently `litellm`) are excluded from both checks because they forward to an unrelated upstream that gains no KV-cache benefit and may 400 on the extra field; users running a custom proxy in front of a llama.cpp-style backend can opt in via the sparse `compat.replayReasoningContent: true` override. Signals to the `openai-completions` encoder that preserved `thinking` blocks must be re-emitted as `reasoning_content` on every assistant turn so chat templates that reconstruct `<think>…</think>` from the field (Qwen3, DeepSeek-R1, GLM-5.x) keep the prior turn's tokens byte-stable and llama.cpp's prefix KV cache survives. ([#3528](https://github.com/can1357/oh-my-pi/issues/3528))

## [16.1.20] - 2026-06-25

### Fixed

- Fixed direct Anthropic Claude Sonnet/Haiku 4.5 advisor/agent turns crashing every call with HTTP 400 `This model does not support the effort parameter.` The catalog classified the whole Claude 4.5 family on `anthropic-messages` (and `bedrock-converse-stream`) as `anthropic-budget-effort`, which made the Anthropic provider serialize `output_config.effort` alongside `thinking.budget_tokens`. Anthropic only honors `output_config.effort` on Opus 4.5 and adaptive (4.6+) Messages-API models, so Sonnet 4.5 / Haiku 4.5 rejected the field. `inferThinkingControlMode` now gates `anthropic-budget-effort` to `parsedModel.kind === "opus" && semverGte(version, "4.5")` on both Anthropic-routed APIs, so Sonnet 4.5 / Haiku 4.5 on direct Anthropic + Cloudflare-AI-Gateway + Vertex + GitLab-Duo + Copilot + Bedrock fall through to plain `mode: "budget"` (thinking budget still scales with the selected effort tier). Opus 4.5 keeps `anthropic-budget-effort`. `anthropic-budget-effort` also stays in use for Anthropic-compatible third-party backends that natively support the field (Umans GLM 5.2). ([#3497](https://github.com/can1357/oh-my-pi/issues/3497))

## [16.1.17] - 2026-06-24

### Fixed

- Fixed the Umans GLM-5.2 thinking-level picker collapsing to a single `high` tier after dynamic discovery: the `max` upstream level now resolves to the internal `xhigh` effort, the picker shows both `high` and `xhigh`, and the metadata maps `xhigh` back to Umans's native `max` wire tier. ([#3192](https://github.com/can1357/oh-my-pi/issues/3192))
- Fixed GitHub Copilot business and enterprise endpoints accepting image inputs that they reject with `400 vision is not supported`. The Copilot `/models` response advertises `capabilities.supports.vision = true` for Claude/GPT chat models on every host, but only the canonical personal endpoint (`https://api.githubcopilot.com`) actually serves them; `githubCopilotModelManagerOptions` now forces `input: ["text"]` whenever discovery resolves to a non-personal base URL, and `mergeDynamicModel` honours the dynamic value (instead of OR-upgrading) when the merged endpoint differs from the bundled reference. ([#3387](https://github.com/can1357/oh-my-pi/issues/3387))
- Fixed OpenRouter Anthropic compat to strip Responses reasoning history during replay so signed thinking blocks are not sent back to routed Anthropic providers. ([#3399](https://github.com/can1357/oh-my-pi/issues/3399))

## [16.1.14] - 2026-06-22

### Added

- Added Sakana AI provider support with Fugu model integration
- Added Sakana AI/Fugu provider catalog entries with Fugu model discovery and Responses API metadata
- Added support for "xhigh" reasoning tier across model configurations
- Added configuration for new models GCP-5.4 Mini, GPT-5.5, and variants
- Added `devin` variant collapse table to streamline model tiering

### Changed

- Updated reasoning label pattern to include "minimal" and "max" efforts
- Simplified model identification logic for Devin-powered reasoning models
- Refactored variant routing to consolidate and standardize tier definitions

## [16.1.13] - 2026-06-22

### Added

- Added support for Devin as a model provider
- Added capability to fetch dynamic models from the Devin model manager

## [16.1.11] - 2026-06-21

### Fixed

- Fixed Umans `umans-glm-5.1` / `umans-glm-5.2` advertising native image input. The `models/info` endpoint reports `supports_vision: "via-handoff"` for the GLM models, meaning vision routes through a separate handoff pre-analysis step instead of accepting raw image blocks; `umansSupportsVision` treated any non-empty string as native vision support, so image prompts went directly to GLM and were rejected with `400 This model does not support image inputs`. The helper now requires `supports_vision === true`, the bundled GLM 5.1/5.2 rows are corrected to text-only, and stale mismatched Umans cache rows for those ids are dropped so the vision-handoff path runs even before a successful refresh. ([#3184](https://github.com/can1357/oh-my-pi/issues/3184))

## [16.1.9] - 2026-06-21

### Fixed

- Fixed the `moonshot` provider with no path to the Kimi China API: model discovery now honors a `MOONSHOT_BASE_URL` override (redirecting to `api.moonshot.cn`), and `KIMI_API_KEY` resolves as a fallback for `MOONSHOT_API_KEY`. ([#2883](https://github.com/can1357/oh-my-pi/issues/2883))
- Fixed LiteLLM model discovery preserving colliding models.dev transport metadata (for example `ollama-cloud` `deepseek-v4-flash`) instead of keeping the LiteLLM `openai-completions` provider transport. ([#3162](https://github.com/can1357/oh-my-pi/issues/3162))

### Removed

- Removed bundled Wafer Pass (`wafer-pass`) catalog entries and generation support; Wafer Serverless remains available as `wafer-serverless`.

## [16.1.8] - 2026-06-20

### Fixed

- Fixed Fireworks-hosted Qwen turns (e.g. `fireworks/qwen3.7-plus`) failing with `400 Extra inputs are not permitted, field: 'enable_thinking'`. Fireworks serves Qwen3 with controllable thinking via OpenAI-style `reasoning_effort` and rejects the top-level `enable_thinking` boolean that Alibaba DashScope speaks; `buildOpenAICompat` was selecting `thinkingFormat: "qwen"` from the `qwen` id pattern regardless of host. Fireworks-hosted Qwen models now resolve to `thinkingFormat: "openai"`.
- Fixed MiMo models on OpenAI-compatible gateways to expose only accepted `low`, `medium`, and `high` reasoning tiers and map unsupported raw `minimal`/`xhigh` requests to safe wire values. ([#2864](https://github.com/can1357/oh-my-pi/issues/2864))

## [16.1.7] - 2026-06-20

### Fixed

- Fixed MiniMax-M3 catalog context for the MiniMax Coding/Token Plan providers `minimax-code` and `minimax-code-cn` to report the documented 1M long-context tier instead of the upstream 512K pricing boundary; the previous patch only covered `minimax`/`minimax-cn`, so the Coding Plan picker still showed 512K in the status bar ([#3097](https://github.com/can1357/oh-my-pi/issues/3097)).

## [16.1.4] - 2026-06-19

### Fixed

- Fixed Claude 4.6 routing on the `google-antigravity` (and `google-gemini-cli`) Cloud Code Assist providers, whose backend exposes the models asymmetrically: `claude-sonnet-4-6` has no `-thinking` twin and `claude-opus-4-6` has only the `-thinking` twin. The shared `thinkingPair` family was routing thinking efforts on `claude-sonnet-4-6` to a non-existent `claude-sonnet-4-6-thinking` wire id (404 `Requested entity was not found`); replaced both 4.6 entries with bespoke single-wire families so every effort and off resolve to the live wire id. Added `claude-sonnet-4-6` and `claude-opus-4-6-thinking` entries to `ANTIGRAVITY_MODEL_WIRE_PROFILES` capped at the backend's 64000-output-token limit (over-cap requests 400'd with `Request contains an invalid argument`); `modelEnum` is now optional on `AntigravityModelWireProfile` since the Claude wire ids are accepted without a captured `labels.model_enum`. ([#3067](https://github.com/can1357/oh-my-pi/issues/3067))

## [16.1.3] - 2026-06-19

### Fixed

- Marked Ollama Cloud catalog models to omit on-the-wire output-token caps, preventing context-window-sized `num_predict` values from causing HTTP 400s for models whose true output cap is not discoverable. ([#2984](https://github.com/can1357/oh-my-pi/issues/2984))
- Fixed `readModelCache`/`writeModelCache` using a process-global shared database even when a custom `dbPath` was provided. Custom-path cache operations now open and close a per-call database via `withModelCacheDb`, preventing leaked SQLite handles on Windows

## [16.1.2] - 2026-06-19

### Added

- Added support for Gemini 2.5 Flash-Lite, 3.1 Flash-Lite, and 3.5 Flash models
- Added support for Moonshot V1 model family

### Changed

- Updated context window and token limits for various Claude, Gemini, and GPT-OSS models
- Refined thinking mode behaviors and routing for supported LLM families

### Fixed

- Fixed GLM-5.2 `reasoning_effort` so the top thinking tier reaches each host's genuine maximum instead of 400ing, mapping the internal `xhigh` tier per host dialect (verified against live endpoints): Z.ai/Zhipu collapse onto the model's `none`/`high`/`max` scale (`xhigh → max`); Fireworks, resellers, and Ollama Cloud keep their distinct lower tiers and remap only the top `xhigh → max` (merged over host quirks such as Fireworks' `minimal → none`); and OpenRouter — whose API rejects `max` and treats `xhigh` as its own max tier — now exposes the `xhigh` tier and forwards it verbatim. Dialect detection keys off resolved `compat.thinkingFormat`, so custom OpenRouter/Z.ai-format providers are covered too.
- Maintained thinking effort routing when discovery only returns the base model ID
- Improved credential retrieval logic for Antigravity and Codex providers via auth discovery

## [16.0.9] - 2026-06-18

### Fixed

- Fixed GitHub Copilot's `anthropic-messages` proxy being misclassified as a non-signing reasoning endpoint (`replayUnsignedThinking: true`). It forwards to signature-enforcing Anthropic, so replaying a stripped/unsigned historical `thinking` block as `signature: ""` — most visibly an end_turn-bound checkpoint/branch-return turn whose signature the transform must strip — caused a `400 Invalid signature` that corrupted the session and re-tripped on every full history re-send (e.g. after toggling MCP servers). Copilot now degrades such blocks to text like the official API. ([#2851](https://github.com/can1357/oh-my-pi/issues/2851))
- Added a `supportsImageDetailOriginal` compat flag that resolves to `false` for GitHub Copilot, whose Responses endpoint rejects the `detail: "original"` image hint with a 400, and `true` for every other host. ([#2822](https://github.com/can1357/oh-my-pi/issues/2822))

## [16.0.8] - 2026-06-18

### Changed

- Refactored model family ID predicates and capability checkers to use a shared, uniform process-lifetime `memo` utility to eliminate caching boilerplate.

### Fixed

- Fixed LM Studio dynamic discovery to use native `/api/v0/models` metadata so VLM models advertise image input. ([#2945](https://github.com/can1357/oh-my-pi/issues/2945))

## [16.0.7] - 2026-06-18

### Fixed

- Fixed MiniMax Anthropic-compatible M2/M3 thinking metadata to expose the adaptive transport and keep M2 mandatory reasoning floored ([#2928](https://github.com/can1357/oh-my-pi/issues/2928)).

## [16.0.6] - 2026-06-18

### Added

- Added a dedicated `openrouter` API type and `ResolvedOpenRouterCompat` configuration to support unified chat-completions and Responses-API compatibility for OpenRouter models

### Changed

- Migrated bundled OpenRouter models in the catalog from `openai-completions` to the new `openrouter` API type
- Consolidated the resolved OpenAI compat shape: extracted a shared `ResolvedOpenAISharedCompat` core that both `ResolvedOpenAICompat` and `ResolvedOpenAIResponsesCompat` extend (each builder still computes its own per-surface value, preserving chat↔Responses divergence), added internal resolved wire-quirk fields (`wireModelIdMode`, `stripDeepseekSpecialTokens`, `reasoningDeltasMayBeCumulative`, `emptyLengthFinishIsContextError`, `usesOpenAIToolCallIdLimit`, `dropThinkingWhenReasoningEffort`, `supportsObfuscationOptOut`), and replaced `buildOpenRouterCompat`'s cast-and-copy with an exhaustive `pickResponsesOnly` composition that fails to compile if a new Responses-only field is added without handling. The public `OpenAICompat` config vocabulary is unchanged.
- Expanded `OpenAICompat`/`ResolvedOpenAISharedCompat` with shared reasoning/history/stream/request flags (`reasoningDisableMode`, `omitReasoningEffort`, `includeEncryptedReasoning`, `filterReasoningHistory`, `requiresReasoningContentForAllAssistantTurns`, `streamMarkupHealingPattern`, `promptCacheSessionHeader`, etc.) so model/provider/gateway constraints are declared once in catalog compat and then consumed uniformly by Chat Completions and Responses endpoints.

### Fixed

- Changed the default compatibility builder for `openai-completions` to set `requiresAssistantAfterToolResult` to `isMistral`, enabling the synthetic assistant bridge for built-in Mistral and Devstral models.
- Fixed local Ollama (`provider: "ollama"`) reasoning turns still failing with HTTP 400 `invalid reasoning value: "minimal"` when the model was selected from a stale `~/.veyyon/models.db` cache row or a hand-written config: the `minimal → low` / `xhigh → max` remap was only stamped during fresh discovery, so cached and custom specs reached the wire unmapped. The remap now lives in the OpenAI chat-completions and Responses compat builders, so every `buildModel` (including cache loads, custom specs, and the `whenThinking` variant) backfills it — no `omp models refresh` required. Custom OpenAI-compatible providers registered under a non-`ollama` provider id still need their own `compat.reasoningEffortMap`.
- Advertised Ollama Cloud GLM-5.2 reasoning efforts as high/xhigh-only and mapped `xhigh` to native max effort ([#2911](https://github.com/can1357/oh-my-pi/pull/2911) by [@serverinspector](https://github.com/serverinspector))
- Fixed OpenRouter pseudo-API model construction so bundled OpenRouter models resolve shared OpenAI compatibility metadata instead of an undefined compat record.
- Fixed custom/direct `xai-oauth` Responses model specs (e.g. `grok-build`) emitting `reasoning.effort` and hitting xAI's HTTP 400: `buildOpenAIResponsesCompat` now defaults `supportsReasoningEffort` to `false` for `xai-oauth` Grok models that are off the effort-capable allowlist (`grok-3-mini`/`grok-4.20-multi-agent`/`grok-4.3`), matching the curated discovery path; explicit `compat.supportsReasoningEffort` still overrides. The allowlist moved to a shared `isGrokReasoningEffortCapable` identity helper consumed by both the compat builder and provider-model curation so the two cannot drift.

## [16.0.5] - 2026-06-17

### Added

- Added `enableGeminiThinkingLoopGuard` to OpenAI compatibility options to allow explicit opt-in or opt-out of the Gemini thinking-loop guard for OpenAI-compatible model aliases
- Added `LITELLM_BASE_URL` as the LiteLLM provider discovery base URL fallback, with discovery caches scoped by the resolved proxy URL and explicit provider `baseUrl` config kept at higher precedence. ([#2726](https://github.com/can1357/oh-my-pi/issues/2726))
- Added `ThinkingConfig.effortBudgets` (per-effort thinking-budget contract baked into collapsed variants) and `ANTIGRAVITY_MODEL_WIRE_PROFILES` (`maxOutputTokens` + `model_enum` per Antigravity wire id) to mirror the captured Antigravity Cloud Code Assist client request shape.

### Changed

- Defaulted `enableGeminiThinkingLoopGuard` from Gemini family detection for both OpenAI completions and responses compatibility specs so Gemini models now enable the thinking-loop guard automatically
- Updated the default Gemini CLI user-agent version fallback to 0.46.0.
- Changed the Antigravity (`google-antigravity`, daily-cloudcode-pa) gemini-3.x collapse families to the `budget` thinking transport with the client's per-tier `thinkingBudget` (3.5 Flash low/medium/high = 1000/4000/10000, 3.1 Pro low/high = 1001/10001) and corrected 3.5 Flash effort→wire routing (medium → `gemini-3.5-flash-low`, high → `gemini-3-flash-agent`). Split the shared CCA collapse table so `google-gemini-cli` (cloudcode-pa) keeps the `google-level` `thinkingLevel` transport for official Gemini CLI parity. Stale collapsed snapshots (bundled catalog, recycled `gemini-3-flash` alias) self-heal from the hand table at collapse time, and the model cache schema is bumped to v7 to invalidate pre-budget Antigravity rows.
- Changed the Antigravity user-agent to the `antigravity/hub/<version>` format (default `2.1.4`) to match the captured client.

### Fixed

- Fixed `off` effort routing for `claude-opus-4-5` and `claude-opus-4-6` to use their base model IDs when thinking is disabled
- Fixed `gemini-2.5-flash` effort routing so all non-off effort levels resolve to `gemini-2.5-flash-thinking`
- Fixed shared variant alias provider resolution so `resolveBareVariantAlias` reports all matching providers when model aliases are present in both CCA collapse tables
- Routed google-antigravity default baseUrl to the stable primary daily endpoint in the catalog generator and all fallback snapshots, resolving connection drops on heavy queries.
- Fixed MiniMax M3 dialect selection so MiniMax-family OpenAI-compatible models use the MiniMax tool-call dialect instead of generic XML. ([#2759](https://github.com/can1357/oh-my-pi/issues/2759))
- Fixed GitHub Copilot dynamic discovery to honor plan-specific API endpoints stored in structured OAuth credentials. ([#2876](https://github.com/can1357/oh-my-pi/issues/2876))

## [16.0.4] - 2026-06-17

### Fixed

- Fixed GLM-5.2 catalog thinking metadata for Zhipu/BigModel so the top effort is exposed as `xhigh` and maps to provider-native `max`. ([#2833](https://github.com/can1357/oh-my-pi/issues/2833))

## [16.0.2] - 2026-06-16

### Fixed

- Fixed Kimi output caps for Umans AI Coding Plan and Venice so discovery metadata cannot use context-sized token ceilings as request caps.
- Marked Umans Anthropic-compatible models as client-tool escaped so cached and bundled metadata do not expose `web_search` as a provider server tool.

## [16.0.1] - 2026-06-15

### Added

- Added the Umans AI Coding Plan provider catalog with Anthropic-compatible model metadata and dynamic discovery ([#2636](https://github.com/can1357/oh-my-pi/pull/2636) by [@oldschoola](https://github.com/oldschoola)).

## [16.0.0] - 2026-06-15

### Breaking Changes

- Renamed the catalog-owned tool syntax API from `ToolCallSyntax`/`FALLBACK_TOOL_SYNTAX`/`preferredToolSyntax` to `Dialect`/`FALLBACK_DIALECT`/`preferredDialect`.

## [15.13.3] - 2026-06-15

### Added

- Added Azure OpenAI as a catalog provider (`azure`, default model `gpt-5.5`, env var `AZURE_OPENAI_API_KEY`), bundling the OpenAI-family models Azure serves over the Responses API (GPT-4/4.1/4o, GPT-5 family, o-series, Codex). Like Amazon Bedrock it is catalog-only — models ship in the bundle and become selectable once the env key is set, with the deployment base URL resolved at runtime from `AZURE_OPENAI_BASE_URL`/`AZURE_OPENAI_RESOURCE_NAME`.
- Added models.dev-backed bundled catalogs for providers that previously shipped no offline models: Hugging Face, Kilo, Moonshot, NanoGPT, Synthetic, Venice, Ollama Cloud, and the Xiaomi Token Plan regions (ams/cn/sgp). They still discover live when credentialed; the bundle is now a non-empty baseline.

### Changed

- Updated stale provider default models to their latest bundled versions: OpenAI-family providers (`azure`, `github-copilot`, `aimlapi`) → GPT-5.5; Gemini providers (`google`, `google-gemini-cli`, `google-vertex`) → `gemini-3.1-pro-preview`; GLM providers (`zai`, `zhipu-coding-plan`) → `glm-5.2`, `cerebras` → `zai-glm-4.7`; Kimi providers (`fireworks`, `opencode-go`, `moonshot`) → `kimi-k2.7-code`, `kimi-code` → `kimi-for-coding`, `together` → `moonshotai/Kimi-K2.7-Code`; `alibaba-coding-plan` → `qwen3.7-plus`; and Claude-Sonnet defaults (`cloudflare-ai-gateway`, `cursor`, `gitlab-duo`, `kilo`, `opencode-zen`, `vercel-ai-gateway`) → Claude Opus 4.x.
- Restricted models.dev Azure discovery to OpenAI-family IDs (`gpt-`, `o1`, `o3`, `o4`, `codex`, `chatgpt`), excluding Foundry-hosted third parties (Claude/DeepSeek/Llama/Mistral/Phi) that Azure serves through non-Responses APIs.
- Detected the Azure OpenAI Responses compat surface (developer role, strict tool mode, strict tool-result pairing) by provider id as well as base URL, so bundled `azure` models whose deployment host is only known at runtime still get the right wire behavior.
- Renamed the `Qwen3-ASR-Flash` model label to `Qwen3 ASR Flash`

### Fixed

- Fixed tool syntax selection for Gemini-family and Gemma model IDs by routing them to dedicated `gemini` and `gemma` formats instead of generic XML
- Fixed `zhipu-coding-plan` and `together` shipping no bundled models: their descriptors referenced non-existent models.dev keys (`zhipu-coding-plan`, `together`); pointed them at the real keys (`zhipuai-coding-plan`, `togetherai`) so they bundle their GLM and full catalogs respectively.
- Folded the `azure-openai-responses` API into the OpenAI Responses thinking-inference branches so Azure reasoning models (o-series, GPT-5, Codex) resolve the discrete effort vocabulary (including `xhigh`) and effort-control mode instead of falling through to generic defaults.
- Fixed `ollama-cloud` discovery inheriting an unsafe cross-provider `contextWindow`/`maxTokens` when `/api/show` returns no size metadata; it now falls back to the safe 128K context / 8K output caps.
- Dropped internal Fireworks control-plane resource ids (`accounts/fireworks/{models,routers}/…`) from the bundle; only the public request ids ship.

## [15.13.2] - 2026-06-15

### Added

- Added the `ToolCallSyntax` union and `FALLBACK_TOOL_SYNTAX` constant to `@veyyon/catalog/identity` (re-exported from `@veyyon/ai/grammar`).
- Added `preferredToolSyntax(modelId)` to `@veyyon/catalog/identity`, resolving a model's native tool-call syntax affinity from its family token (Claude→`anthropic`, GLM→`glm`, Kimi→`kimi`, Qwen→`qwen3`, DeepSeek→`deepseek`, OpenAI/gpt-oss→`harmony`, else the `xml` fallback).
- Added `flux-1-schnell-fp8` to the Fireworks serverless model catalog
- Added `gpt-oss-20b` to the Fireworks model catalog
- Added `qwen3-embedding-8b` to the Fireworks model catalog
- Added `qwen3-reranker-8b` to the Fireworks model catalog
- Added `Gemma 4 E2B IT` and `Gemma 4 E4B IT` to the Google model catalog
- Added `qwen/qwen3-asr-flash` to the Zenmux model catalog
- Added sparse `supportsTools` model metadata so providers can mark models that require in-band tool-call formatting.

### Changed

- Kept non-tool-capable Fireworks serverless models in discovery results and marked them with `supportsTools: false` for fallback-aware handling
- Extended `modelFamilyToken(modelId)` to classify Claude/OpenAI ids the structured parser misses (older dated forms such as `claude-3-5-sonnet-20241022` and `gpt-4o`), returning `anthropic`/`openai` instead of an empty token.

## [15.13.1] - 2026-06-15

### Added

- Added `modelFamilyToken(modelId)` to `@veyyon/catalog/identity`: a coarse vendor-lineage token (`anthropic`/`openai`/`gemini`/`kimi`/…) for "are two models the same family?" comparisons, backed by `parseKnownModel` canonical-id normalization. Opaque and comparison-only; kind/variant collapsed onto the vendor token ([#2406](https://github.com/can1357/oh-my-pi/issues/2406))

### Changed

- Changed catalog metadata to update a model’s per-token pricing to input 0.09 and output 0.18
- Changed the same cataloged model’s maximum token limit from 384000 to 65536

### Fixed

- Fixed MiniMax-M3 catalog context for `minimax` and `minimax-cn` to report the documented 1M long-context tier instead of the upstream 512K pricing boundary ([#2576](https://github.com/can1357/oh-my-pi/issues/2576)).
- Fixed OpenCode Go MiMo catalog metadata so title generation and other tool-enabled calls omit unsupported `tool_choice` instead of triggering provider 400s ([#2509](https://github.com/can1357/oh-my-pi/issues/2509)).
- Fixed OpenCode Go `kimi-k2.7-code` catalog metadata so resolve-gate requests use automatic tool selection instead of Moonshot-rejected forced `tool_choice` ([#2546](https://github.com/can1357/oh-my-pi/issues/2546)).
- Fixed Anthropic compat for the `github-copilot` host so `supportsEagerToolInputStreaming` defaults to `false` there, matching the Copilot proxy which rejects the per-tool `eager_input_streaming` field ([#2558](https://github.com/can1357/oh-my-pi/issues/2558)).
- Scoped vLLM model cache validity to the discovery base URL so changed endpoints refetch immediately, and bounded built-in vLLM discovery requests with a timeout.

## [15.12.6] - 2026-06-14

### Added

- Added GLM-5.2 to the bundled zai (GLM Coding Plan) catalog as the selectable 1M served model.

### Changed

- Pinned zai `glm-5.2` to 1M context during catalog generation so endpoint discovery and older fallbacks cannot regress it to 200k.
- Replaced the hand-maintained `zhipu-coding-plan` GLM reasoning allowlist and vision regex with a `parseGlmModel` family classifier in `identity/classify.ts` (variant + vision + version), surfaced as `isReasoningGlmModelId` / `isGlmVisionModelId`. Discovery now derives reasoning/vision capability from the GLM family instead of a per-id list, so newly-bumped integers (`glm-5.3`, `glm-6`, …) are covered automatically while `-flash`/`-preview` and the vision `…v` shape stay correctly classified.

## [15.12.4] - 2026-06-13

### Added

- Added bundled Fireworks models `deepseek-v4-flash`, `kimi-k2.7-code`, `minimax-m2.5`, `minimax-m3`, `nemotron-3-ultra-nvfp4`, `qwen3.6-plus`, and `qwen3.7-plus`
- Changed

### Changed

- Model `contextWindow`/`maxTokens` are now `number | null`; discovery emits `null` when a provider reports no limit, replacing the `222222`/`8888` (`UNK_CONTEXT_WINDOW`/`UNK_MAX_TOKENS`) sentinels (now removed). Bundled `models.json` unknown limits are `null`.
- Changed the `github-copilot` model context window to `524288` tokens
- Changed Fireworks model discovery to source the control-plane `List Models` API (`GET /v1/accounts/fireworks/models?filter=supports_serverless=true`) instead of the OpenAI-compatible `/v1/models` inference listing. The inference endpoint returns a sparse, account-specific subset that omits on-demand serverless models (e.g. `kimi-k2.7-code`), so newly published serverless models stayed invisible in the picker until hand-added to the bundled catalog. The control-plane catalog enumerates every serverless model with capability metadata (`supportsServerless`/`supportsTools`/`supportsImageInput`/`contextLength`/`displayName`), paginated and filtered to tool-capable `READY` entries, then merged with bundled/models.dev references — the Kimi K2 max-output clamp and DeepSeek V4 thinking-toggle strip are preserved, and unbundled models default to reasoning so `buildModel` derives the Fireworks effort map. New serverless releases now surface automatically with no catalog edits.

### Fixed

- Filled missing `contextWindow` and `maxTokens` in generated `models.json` for proxy/reseller variants by inheriting limits from canonical-family and segment-reference models
- Ignored zero-cost `x-ai` subscription entries as reference sources when backfilling limits so inflated values are not propagated
- Fixed the model cache opening with `PRAGMA journal_mode=WAL` before `PRAGMA busy_timeout`, so concurrent omp startups could crash inside `getDb()` on `SQLITE_BUSY` during WAL recovery instead of waiting through the transient lock. The busy handler is now installed before the first lock-taking statement ([#2421](https://github.com/can1357/oh-my-pi/issues/2421)).

## [15.11.8] - 2026-06-12

### Fixed

- Fixed Antigravity `gemini-3.1-pro --thinking high` failing with `Cloud Code Assist API error (400): Request contains an invalid argument.` — the upstream `gemini-3.1-pro-high` deployment rejects every `streamGenerateContent` request on both CCA endpoints while discovery still advertises it. High effort now routes to `gemini-pro-agent` (the same "Gemini 3.1 Pro (High)" model, verified accepting the identical request body), and the model-cache fingerprint version was bumped (`merge-v2` → `merge-v3`) so existing fresh caches refetch discovery and pick up the corrected routing immediately.

## [15.11.7] - 2026-06-12

### Added

- Added effort-tier variant collapsing (`variant-collapse`): providers that expose one logical model as several effort/thinking-suffixed upstream ids (Antigravity CCA `gemini-3.5-flash-extra-low`/`-low`/`gemini-3-flash-agent`, `gemini-3[.1]-pro-low|high`, `claude-*[-thinking]` pairs, `gpt-oss-120b-medium`) collapse into one logical entry carrying per-effort upstream routing in `thinking.effortRouting` (plus `thinking.suppressWhenOff` for Cloud Code Assist ids whose baked server default re-applies when `thinkingConfig` is omitted). Request-time code resolves the outbound id via `resolveWireModelId(model, effort)`; selection, caching, and usage attribution key on the logical id.
- Added the automatic `X`/`X-thinking` pair rule (`deriveThinkingPairFamilies`): any provider's live bare/thinking twin collapses into the bare id, routing thinking-enabled requests to the `-thinking` backing id (trailing or infix token, so `kimi-k2-thinking-turbo` pairs with `kimi-k2-turbo`). Gated on same api and compatible pricing — all-zero cost rows count as unknown, while twins that both carry real, differing prices remain separate SKUs.
- Added `collapseBuiltModelVariants` and wired collapsing at every materialization point — Antigravity discovery, the catalog generator, and the model-manager merge — so stale sources (old static beside collapsed dynamic results, mixed cache rows) converge on logical entries instead of unioning raw tier ids back into the catalog.
- Added `thinking.requiresEffort`, baked for reasoning-only upstreams — Gemini 3.x (levels only, no off), Gemini 2.5 Pro (thinkingBudget floors at 128, rejects 0), OpenAI o-series, MiniMax M2, and thinking-variant SKUs (`*-thinking`/`*-reasoner`/`*-reasoning`, with a negation-aware token grammar so `non-thinking` ids never match). Identity derivation bakes it for new entries and `fillThinkingWireDefaults` backfills explicit/cached metadata; `minimumSupportedEffort` exposes the canonical floor. Pair-collapsed twins drop member flags (their off routes to the bare SKU), while identity re-flags pairs whose logical id is itself mandatory

### Changed

- Changed model display names to drop model-extrinsic decorations: gateway author prefixes (`OpenAI: …`, `Google: …`), `(latest)` alias markers, `(Antigravity)` provider attribution, price tiers (`($$$$)`), and promo/lifecycle tags (`(20% off)`, `(retires …)`). `cleanModelName` is applied in `buildModel` (covers live discovery and stale caches) and as a catalog-generator pass; Antigravity discovery no longer appends `(Antigravity)` to display names. Variant tags that map to distinct wire ids (`(Thinking)`, `(free)`, `(Fast)`, dates, regions) are preserved.
- Changed the `google-antigravity` default model from `gemini-3-pro-high` to `gemini-3.1-pro`
- Changed `gemini-2.5-flash-thinking` handling from discovery-denylist to collapsing into `gemini-2.5-flash` (thinking-enabled requests route to the `-thinking` backing id)
- Bumped the model cache schema to v5 so rows predating effort-tier variant collapsing (raw `-low`/`-high`/`-thinking` member ids) are invalidated

### Fixed

- Fixed catalog generation to apply effort-tier variant collapsing before provider grouping to ensure collapsed model families are consistently materialized without being impacted by in-loop mutation
- Fixed Kimi K2.6 OpenAI-compatible compat metadata to use a 300s stream watchdog floor, covering Fire Pass router ids as well as public `kimi-k2.6` ids so long reasoning starts do not hit the generic first-event timeout ([#2366](https://github.com/can1357/oh-my-pi/issues/2366)).

## [15.11.4] - 2026-06-12

### Fixed

- Fixed MiniMax M2-family and OpenAI gpt-oss model metadata so OpenAI-compatible catalog entries declare only `low|medium|high` thinking efforts. Their upstreams reject `minimal`, `xhigh`, and Fireworks' `minimal → none` wire mapping, so `fireworks/minimax-m2.7` as the smol auto-thinking classifier model 400ed on every turn. OpenAI-compatible provider effort maps (`Groq qwen/qwen3-32b`, DeepSeek-family, OpenRouter Anthropic adaptive, Fireworks `minimal → none`) now bake into `thinking.effortMap` in catalog metadata instead of `buildOpenAICompat`, and request builders read that field directly. Regenerated `models.json` now makes `disableReasoning` choose `low` for those families while leaving GLM-5.x and other Fireworks models on the existing `minimal → none` path ([#2315](https://github.com/can1357/oh-my-pi/issues/2315)).

### Added

- Added `requiresJuiceZeroHack` Responses-API compat flag, resolved by `buildOpenAIResponsesCompat` from GPT-5-family model names and overridable via sparse model `compat` config. Replaces the request-time `model.name.startsWith("gpt-5")` sniff that gated the trailing `# Juice: 0 !important` no-reasoning developer item.

## [15.11.3] - 2026-06-11

### Added

- Added `requestModelId` on `Model` to represent the upstream model id used when a catalog entry is a local variant
- Added synthetic GitHub Copilot long-context model variants with `-1m` suffixes when tiered token pricing is advertised

### Changed

- Changed GitHub Copilot discovery to request `X-GitHub-Api-Version: 2026-06-01` from `api.githubcopilot.com`
- Changed GitHub Copilot discovery to cap base model `contextWindow` to the default token tier and keep long-context access as the separate `-1m` model entry
- Changed Copilot model mapping to omit non-chat `/models` entries and enable image input for models whose capabilities indicate vision support

### Fixed

- Fixed long-context variant pricing to use `billing.token_prices.long_context` rates instead of default model pricing
- Fixed `mapModel` handling in OpenAI-compatible discovery so returning `null` now skips a model entry rather than falling back to defaults
- Fixed model ID precedence so a real upstream Copilot model id is kept when it conflicts with a synthesized `-1m` variant

## [15.11.1] - 2026-06-11

### Fixed

- Fixed NVIDIA NIM Qwen turns failing with `400 Validation: Unsupported parameter(s): enable_thinking`. NIM's chat-completions schema is `additionalProperties: false` and exposes thinking via the vLLM convention `chat_template_kwargs.enable_thinking`; `buildOpenAICompat` was sending top-level `enable_thinking` for every `qwen/*` id regardless of host. Registered `nvidia` as a known host (`integrate.api.nvidia.com`) and routed NVIDIA-hosted Qwen models to `thinkingFormat: "qwen-chat-template"` ([#2299](https://github.com/can1357/oh-my-pi/issues/2299)).
- Fixed Moonshot/Kimi native OpenAI-compatible request metadata so Kimi K2 uses `max_tokens` and omits OpenAI-only `store`, restoring first-turn output with `MOONSHOT_API_KEY` ([#2289](https://github.com/can1357/oh-my-pi/issues/2289)).

## [15.11.0] - 2026-06-10

### Fixed

- Fixed `buildModel` so malformed explicit thinking metadata without `efforts` is treated as sparse input and inferred instead of crashing during model resolution ([#2251](https://github.com/can1357/oh-my-pi/issues/2251)).

## [15.10.12] - 2026-06-10

### Added

- Added `grok-composer-2.5-fast` (Cursor "Composer 2.5 Fast") to the xAI Grok OAuth (SuperGrok) catalog: non-reasoning, text-only, 200K context.

### Changed

- Set every xAI Grok OAuth (SuperGrok) curated model's max output tokens to mirror its context window (`grok-build`, `grok-4.3`, `grok-4.20-0309-{reasoning,non-reasoning}`, `grok-4.20-multi-agent-0309`, `grok-composer-2.5-fast`), replacing the `8888` `UNK_MAX_TOKENS` placeholder (and a stale `30000` on three grok-4.x entries). xAI's OAuth `/v1/models` reports no per-request output limit, so the curated catalog now owns `maxTokens` like `contextWindow`, deterministic on both the static-seed and online-overlay paths; the `openai-responses` wire still clamps the actual request to `OPENAI_MAX_OUTPUT_TOKENS` (64k).

### Fixed

- Excluded zero-cost `xai-oauth` subscription entries from the model reference indexes (`buildModelReferenceIndex`, `createReferenceResolver`), so their zero pricing and context-window-sized `maxTokens` cannot outrank paid/public Grok references when resolving custom-provider model identities.

## [15.10.11] - 2026-06-10

### Added

- Added `hostMatchesUrl`, `modelMatchesHost`, and endpoint-shape helpers in the new `hosts` module for consistent provider/baseUrl matching
- `buildModel(spec)` (`build.ts`) is now the single Model constructor: it materializes the fully-resolved compat record and canonical thinking metadata exactly once (compat first, thinking derived from identity + resolved compat), so `Model.compat` is a required, complete `CompatOf<TApi>` (`ResolvedOpenAICompat`/`ResolvedOpenAIResponsesCompat`/`ResolvedAnthropicCompat`) and request-path code reads fields with zero URL parsing and zero per-request allocation. Sparse user/config overrides live on the new `ModelSpec<TApi>` input shape and survive on `Model.compatConfig` for introspection.
- Added `ResolvedAnthropicCompat.supportsSamplingParams` (Opus 4.7+/Fable/Mythos reject `temperature`/`top_p`/`top_k` with a 400), baked at build time from model identity so the request path stops re-parsing model ids.
- Compat detection gained model-time flags so handlers stop sniffing baseUrl: completions `supportsReasoningParams`, `alwaysSendMaxTokens`, `isOpenRouterHost`, `isVercelGatewayHost`, `streamIdleTimeoutMs`, and a precomputed `whenThinking` alternate view (OpenCode `reasoning_content` gating, #1071/#1484); responses `strictResponsesPairing`, `supportsLongPromptCacheRetention`, `supportsReasoningEffort`; anthropic `officialEndpoint`, `requiresToolResultId`, `replayUnsignedThinking`.
- New `@veyyon/catalog` package: the model catalog extracted from `@veyyon/ai`. Owns the bundled `models.json` and its generation pipeline (`scripts/generate-models.ts`), the core model data types (`Model`, `Api`, `ThinkingConfig`, `Effort`, `Usage`, compat interfaces), thinking metadata enrichment and generated policies (`model-thinking.ts`), the SQLite model cache and model manager, per-provider discovery factories (`provider-models/`), the discovery protocol clients (`discovery/`), and the new `CATALOG_PROVIDERS` table — the single source of truth for provider ids, default models, and discovery wiring (`KnownProvider`, `PROVIDER_DESCRIPTORS`, and `DEFAULT_MODEL_PER_PROVIDER` are derived from it).
- New `identity/` module centralizing model-identity concerns that were previously duplicated across packages: family classification and version parsing (`identity/classify.ts`, extracted from pi-ai's `model-thinking` internals), canonical model equivalence with injected reference data (`identity/equivalence.ts`, from coding-agent's `model-equivalence`), proxy/reseller reference lookup (`identity/reference.ts`, from coding-agent's `model-registry`), bracket-affix and id-segment helpers (`identity/id.ts`), a single trailing-marker vocabulary with canonical vs reference flavors (`identity/markers.ts` — `search` stays reference-only so Perplexity's `sonar-pro-search` remains canonical-distinct), and provider priority ordering (`identity/priority.ts`).
- Memoized bundled-reference accessors (`getBundledCanonicalReferenceData` / `getBundledModelReferenceIndex` in `identity/bundled.ts`): one lazy walk of the bundled catalog feeds both canonical equivalence and proxy-reference lookup, so consumers no longer hand-roll the glue.
- `identity/selection.ts`: pure canonical-variant selection (`resolveCanonicalVariant`, `buildCanonicalModelOrder`, `CanonicalVariantPreferences`) extracted from the coding-agent registry — provider rank, then exact-id match, variant source, id length, and candidate order.

### Changed

- Changed OpenAI compatibility detection to use shared host classifiers (`modelMatchesHost`/`hostMatchesUrl`) with normalized matching instead of raw URL substring checks
- Changed `hostMatchesUrl`/`modelMatchesHost` usage in compatibility detection to reduce mismatches across case variants and provider alias hosts
- Provider catalog entries now carry the runtime API-key env fallback as an ordered `envVars` list; `catalogDiscovery.envVars` became an optional generation-time override (only `cursor` and `vercel-ai-gateway` differ) and `PROVIDER_DESCRIPTORS` materializes the resolved list for `generate-models.ts`.
- `Model`'s api parameter now defaults to `Api` instead of `any` (`Model<TApi extends Api = Api>`), so bare `Model` no longer behaves as `Model<any>` at call sites.
- `ThinkingConfig` is now explicit and total: an ordered `efforts` array replaces the `minLevel`/`maxLevel`/`levels` range encoding, and the wire facts are baked alongside it — `effortMap` (anthropic-adaptive 4-tier vs 5-tier scale, shared with the OpenRouter completions remap) and `supportsDisplay` (adaptive `display` field support). Explicit spec thinking owns the capability surface (`mode`/`efforts`/`defaultLevel`) and wins over inference; missing wire facts are backfilled from identity so configs never need to know Anthropic's tier tables. Reasoning models that reject the wire effort param (`compat.supportsReasoningEffort: false` on openai-responses*) are encoded as `thinking: undefined` ("thinks, no control surface") instead of the removed `modelOmitsReasoningEffort` special case. `models.json` was re-baked in the new vocabulary behind a 3196-model behavioral parity gate, and the model cache schema bumped to v4 to invalidate old-shape rows.
- `mapEffortToGoogleThinkingLevel(effort)` is now a static map (model parameter dropped — validation stays at the `requireSupportedEffort` call sites), and `mapEffortToAnthropicAdaptiveEffort` reads the baked `thinking.effortMap` instead of re-classifying the model id per request.
- Generator-only policy code moved out of the runtime bundle into `scripts/generated-policies.ts`: `applyGeneratedModelPolicies` (now policy fixups + thinking re-bake via the shared deriver), `linkOpenAIPromotionTargets`, the Copilot context-window table, minimax/opencode-go compat fixups, and `CLOUDFLARE_FALLBACK_MODEL`. The anthropic id predicates (`hasOpus47ApiRestrictions`, `supportsMidConversationSystemMessages`, `isAnthropicFableOrMythosModel`) moved to `identity/family` for build-time use by the compat/thinking derivers only.

### Fixed

- Fixed Anthropic official-endpoint detection to require strict HTTPS hostname matching so non-official or lookalike URLs are no longer treated as official Anthropic hosts
- Fixed Ollama Cloud dynamic discovery so same-id matches from other providers no longer supply context-window or max-output-token limits for discovered models.
- Wired `@veyyon/catalog` into the release publish package list, tarball install smoke test, and root `bun generate-models` script.
- Fixed `supportsAdaptiveThinkingDisplay` only matching dash-form version ids: dotted ids (`claude-opus-4.7`) now classify through `identity/classify` like every other anthropic predicate, so six bundled dotted Opus 4.7/4.8 entries (github-copilot, vercel-ai-gateway, zenmux) regain adaptive `display` support; bare dated ids (`claude-opus-4-20250514` = Opus 4.0) stay excluded.
- Fixed the OpenRouter anthropic adaptive-effort map misclassifying bare dated Opus ids (`claude-opus-4-20250514` parsed as version 4.20 → wrongly adaptive); the map now derives from the shared classifier and the shared 4-/5-tier tables.

### Removed

- Removed the runtime enrichment layer: `enrichModelThinking` (and its non-enumerable memo-slot cache), `refreshModelThinking`, `modelOmitsReasoningEffort`, and the `model-thinking` re-exports of generator-only policies. Thinking metadata is resolved exactly once inside `buildModel`; runtime helpers (`getSupportedEfforts`, `clampThinkingLevelForModel`, `requireSupportedEffort`, the effort mappers) are pure field reads.

## [1.0.47] - 2026-08-13

### Changed

- Comment prose that credited or dated a chat message is gone from the `openai-compat` context-window table; the credit named who reported a defect and never what the code must do. Comments only, so nothing behaves differently.
- No user-facing change: two comments in `model-thinking.ts` say the same thing without an em dash, which is the punctuation this repository's prose uses.
- No user-facing change: `src/models.ts` dropped an import it no longer uses, which was failing the repository's lint gate for every package beside it.
- An effort ladder that no endpoint validates is no longer withheld along with the ones it does. Reading models.dev's `budget_tokens` token RANGE as a declared `[high, max]` level pair created a fabricated surface that then outranked every real declaration, so a row in budget mode collapsed to two rungs and an operator asking for `low` was served `high` on Anthropic, Bedrock, and Gemini alike. That mapping is gone. Three transports send no effort NAME to an endpoint and therefore keep a ladder when nothing is declared: `budget` carries a token count Veyyon computes from its own schedule, `google-level` carries the `thinkingLevel` enum Google publishes per family and no catalogue covers Cloud Code Assist, and MiniMax on the Anthropic endpoint collapses every tier to the single literal `adaptive`. Anthropic rows whose declaration is missing keep the budget dial and drop only the unverified `output_config.effort`, since sending an effort a model rejects is #3497's HTTP 400. The model cache schema is bumped so a row written before ladders came from the endpoint cannot be served: the ladder travels with the spec, so a cached row still offering `minimal` on Fireworks MiniMax is issue #2315 verbatim and cannot be repaired in place. The thinking transports and the OpenAI-compatible disable dialects are now values rather than type-only unions, so the sets can be enumerated at run time and a new member fails the suite until somebody records what an undeclared model on it should get.
- Effort ladders, context windows, and provider listings now come from models.dev declarations only; identity no longer fabricates an effort ladder. `resolveModelThinking` returns no surface when neither the spec nor a models.dev declaration provides one, the picker stays closed for those models instead of offering tiers the endpoint never accepted, and every provider with a models.dev descriptor — now including Fireworks, Baseten, Novita, Vercel AI Gateway, Wafer Serverless, Sakana, and Kimi Code — has its declared `reasoning_options` mapped verbatim. First-party twins inherit the declared surface of their catalog sibling: `openai-codex` from `openai`, `xai-oauth` from `xai`, `opencode` from `opencode-zen`, and the `kimi-for-coding` aliases from the K3 row they route to. Budget-only declarations open the fixed high/max pair, matching opencode's budgetVariants contract. Ollama keeps its host-declared low..max wire vocabulary (models.dev cannot catalog a local daemon), and stale ollama cache rows normalize back to it. models.dev is also a runtime overlay now: one process-memoized, disk-cached, ETag-conditional api.json fetch enriches every descriptor-covered provider field-wise instead of wholesale-replacing static rows, with silent stale-on-failure (the bundled catalog remains the baseline, same contract as opencode's ignored refresh).
- Added shared GPT-5.6 prompt-cache-breakpoint capability classification for OpenAI Responses transports.
- Added a canonical reasoning selection contract that resolves supported effort, wire effort, mandatory-thinking floors, and effort-tier model routing from one model capability.
- The bundled Cursor protobuf binding declares `ConversationTokenDetails.detailed`, the field 3 the schema Cursor's client ships leaves out and protobuf therefore dropped without a trace. It is the provider's own per-bucket breakdown of `used_tokens`, recovered from recorded client bytes and pinned by a sum identity, and `@veyyon/ai`'s Cursor provider now reads it. The binding is regenerated with the toolchain the rest of the generated files already use, which is why every optional message field in it now spells its type as `T | undefined`.
- `Usage` carries what a retried attempt spent, and the three operations on `cost.total` each have one owner. `Usage.discarded` accumulates the tokens and the price of attempts whose text a provider retry threw away, `recomputeCostTotal` is the only place the total is summed (so a service-tier rescale can no longer erase that spend with a hand-written four-field sum), `discardAttemptUsage` is the one way to carry an attempt forward, `scaleUsageCost` is the one way to apply a billing multiplier, and `inheritUsageCarryovers` is how a provider that rebuilds `usage` wholesale from one wire field keeps the facts that rebuild is not allowed to destroy. An attempt its provider already priced keeps that number; only an unpriced one is priced at the model that served it.

### Fixed

- A gateway model whose id carries the gateway's own name resolves to the vendor row it proxies. Cursor serves xAI's 500k `grok-4.5` as `cursor-grok-4.5-medium` and OpenAI's 1,050,000-token `gpt-5.4` as `cursor-gpt-5.4`, and the candidate walk stripped effort tiers, speed suffixes and dash-spelled versions but never a leading provider name, so both fell to the shared 200k assumption. The window is what the compaction trigger is derived from, so a session on a prefixed model compacted at two fifths of the context it had and then reported that a 256k threshold was larger than the model's whole window. The walk now also tries the id with a leading provider id removed, with the vocabulary read out of the bundled provider list at run time (so a new gateway needs no edit) and the longest name winning (`vercel-ai-gateway-gpt-5.4` must not strip `vercel`). The original id is still tried first, so a model whose real name begins with a provider word is unaffected: a gateway-hosted `claude-4.6-sonnet` stays at the 200k Anthropic really publishes. Cursor's model cache namespace is bumped with it, because a cache written under the old rule keeps serving the 200k assumption for its full two-hour life.
- Anthropic budget models offer their five thinking tiers again instead of two. A models.dev `budget_tokens` declaration is a token range and names no level, and mapping it to a fixed `high`/`max` pair (copied from another tool's picker) reached `claude-sonnet-4-5` and `claude-haiku-4-5` as if the endpoint had declared it: minimal, low, medium and xhigh disappeared from the picker, and an operator asking for medium silently got high, because a level a ladder does not carry clamps to one it does. Compaction summaries and handoffs ran at high for the same reason. A budget transport takes any legal integer and Veyyon owns the effort-to-budget schedule, so a row with no declared ladder now carries minimal through xhigh; `max` stays out because the Anthropic and Bedrock schedules give it the same 32768 tokens as `xhigh`, making it a selection that cannot change the request. A declared effort ladder still wins wherever one exists, so Opus 4.5 keeps the low/medium/high surface its endpoint documents.
- An agent gateway no longer describes every model it proxies as Claude-class. Cursor, Devin and Antigravity report their limits badly or not at all, and all three fell straight to the shared 200k/64k assumption, so a gateway-hosted `grok-4.5` — a 500k model — was published at 200k, and a Gemini row at a fifth of its window. The number is not cosmetic: auto-compaction, the context panel, context promotion and the context-overflow check all read it, so the agent compacted at two fifths of the window it had, and an operator with a 256k threshold was told the threshold was larger than the model's context window. Discovery now resolves a gateway model's limits in order — what the endpoint reported, then the catalog's own entry for that model (an effort-tiered id such as `grok-4.5-medium` resolves through its base, because a tier changes how a model thinks and not how much context it has), then the assumption, which is now reached only for a model id the catalog cannot identify at all. The output cap is deliberately not symmetric: a catalog-derived cap is still clamped to 64k because a vendor's own cap is not a promise about the proxy, while a cap the gateway itself reported is taken as given. `src/discovery/gateway-limits.ts` is the one owner, and nothing but it reads the raw assumption.
- A gateway's limits no longer resolve from the gateway's own catalog row, which is where the assumption they were meant to replace is recorded. The first resolver read the whole bundled reference index, so `cursor/gpt-5.1-high` answered the 200k row Cursor discovery had written earlier instead of the 400k `openai/gpt-5.1` row it proxies, and `cursor/gpt-5.4` answered 200k for a 1,050,000 model. Rows belonging to the five gateway providers are now excluded from the evidence, along with any row carrying the assumed 200k/64k pair at zero cost, which is what a row written under the old rule looks like. Cursor also kept taking its limits from its own bundled row on both reference paths, so the fix reached only ids Cursor does not serve, and Devin's dash-spelled versions (`gpt-5-4`, `gemini-3-1-pro`) and stacked `-high-fast` suffixes resolved to nothing and fell to the assumption; both spellings now reach the vendor row. Cached discovery rows written under the old rule are retired by a model-cache version bump, because the startup model list reads the cache with a 24 hour TTL and the refresh path serves a stale row while backoff applies, so without the bump an upgraded user kept being told a 1M-token model holds 200k.
- Fixed Devin discovery publishing 1 model instead of 169, which made every Devin model except the free `swe-1-6-slow` unreachable by name. Three causes, found against the live RPC and the native `devin` CLI's own traffic. The one that did the damage: `normalizeDevinModels` skipped any entry whose `disabled` bool was set, and field 4 is not a disablement flag on the current wire — in the CLI's own fully-entitled response it is true on 171 of 174 entries, `grok-4-5-medium` among them, every one of which the CLI lists as available, and the CLI's compiled `ClientModelConfig` has no `disabled` field at all. `disabled_reason` (field 33) is the signal the server populates, and the filter reads that now. Second, `GetCliModelConfigs` gates entitlement on `ide_name`: identifying as `windsurf` came back with "Upgrade to Pro to access this model" attached to 167 of 168 entries for an account that sees all of them through the CLI, so the identity is the CLI's own `chisel` and is shared with the chat provider in `@veyyon/ai` as that contract already required. Third, the request now sends `supported_model_displays`, without which the server withholds 6 entries including `adaptive`; asking only for the user-facing styles `[3, 8]` also leaves the CLI's five internal harness roles (`subagent-default`, `swe-check` and friends) server-side rather than offering them as selectable models.
- Fixed Claude models served through OpenRouter losing Anthropic prompt caching entirely. `buildOpenAICompat` decided `cacheControlFormat` with a raw `spec.id.startsWith("anthropic/")` test while the same function had already computed the correct predicate as `isAnthropicModel`. The bundled catalog carries four alias rows spelled `~anthropic/claude-*-latest`, where the leading tilde sorts them to the top of the model picker and makes them the likeliest Claude-on-OpenRouter selection, and the prefix test is false for every one of them. With no `cacheControlFormat`, the completions path returned before writing a breakpoint and the provider re-read the whole conversation at full input rate on every turn. Nothing failed loudly; the only symptom was the bill.
- Fixed `supportsObfuscationOptOut` sending `stream_options.include_obfuscation` to any host an `openai` model was re-pointed at. The gate read `isOpenAIUrl || provider === "openai"`, and the provider clause defeats the endpoint test it is ORed with, so Azure and arbitrary compatible proxies received a field a strict validator rejects with a 400. It is keyed on the endpoint now, through the same `isOfficialOpenAIEndpoint` helper the file already uses, which also keeps an unset `baseUrl` classified as official.
- Removed the unused `isAzureDeploymentsUrl` export. It was a bare `baseUrl.includes("/deployments/")` one-liner with no callers, while the only site needing the check builds the Azure URL inline, so it read as the supported way to classify an Azure deployment and was not one: any host with a `/deployments/` segment would have matched. Azure classification goes through the `azureOpenAI` host markers.
- Ollama discovery reports why a model's `/api/show` lookup failed instead of silently substituting invented metadata. `/api/tags` names the models, but `/api/show` is what says whether one thinks, sees images, and how much context it really has, and every failure of it collapsed into the same `undefined`. Locally the substituted context window then OVERWROTE the real one, so a 32k model was advertised at 128k, prompts were packed to the larger size, and Ollama dropped the front of the context to make them fit: the agent lost its system prompt mid-session and looked like it forgot rather than like it failed. On Ollama Cloud the model kept its place in the picker with thinking and image input quietly stripped, which reads as veyyon not supporting them. `/api/show` gets no retry while `/api/tags` gets three, so one rate-limited request was enough. The reason now travels back through the same `onFailure` every other reader in this package already used, with the model id in the detail because the call runs once per model and "one of them lost its metadata" is not something an operator with a long `ollama list` can act on.
- The local Ollama `/api/tags` fallback reports its own failures instead of returning a bare `null`. It is the last step before an empty picker, and a refused connection to a daemon that is not running, a 403 from a proxy in front of it, and an HTML error page were one silence. The HTML case was worse than silent: the unguarded `response.json()` threw out of the fetcher, so a captive portal became an `unhandled` stage blamed on this reader rather than a `body` failure naming the endpoint.
- A models.dev `reasoning_options` effort declaration that names no level is now read as "reasons, no effort control" rather than falling through to the identity ladder. `none`/`null` is the off sentinel and `default`/`auto` names the endpoint's own choice, so a declaration made only of those states there is nothing to address — the same surface as the empty option list that already mapped this way. Two live rows were affected and both got a fabricated ladder: `cerebras/zai-glm-4.7` declares `["none"]` and was offered five levels, `groq/qwen/qwen3.6-27b` declares `["none","default"]` and was offered four. Every one of them is a value the endpoint says it does not accept, so the picker, `/thinking`, and the saved-effort rows all advertised efforts that could only be rejected on the wire. An `effort` option carrying an unrecognized tier name, or no `values` key at all, still falls back to identity: that is a control Veyyon cannot name yet, not a control that is absent.
- Model identity no longer depends on how a host spells the id. `parseGlmModel`, `parseOpenAIModel`, `parseAnthropicModel` and `parseGeminiModel` matched lowercase-only patterns, so every provider that serves models under their HuggingFace repo names — Baseten's `zai-org/GLM-5.2`, `moonshotai/Kimi-K2.6`, `nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B` — parsed as an unknown family. Nothing failed loudly: each identity-derived policy simply never applied, and the row kept whatever the inference fallback had guessed. The visible cost was a picker full of efforts the endpoint rejects. Baseten's GLM-5.2 route accepts `high` and `max` and returns a 400 for anything else, while Veyyon offered `minimal`, `low`, `medium`, `high`, `xhigh` — four guaranteed 400s, with `max` unreachable — and the rule that says `high`/`max` for GLM-5.2 was already in the tree and had only ever failed to match the id. Two shipped rows change, both GLM-5.2 (`baseten`, `wafer-serverless`), both to the accepted pair.
- The models.dev fallback reports why it produced no models instead of failing silently. `fetchModelsDev` wrapped the whole fetch-and-map in a bare `catch {}` and its `fetch` took no hooks at all, so models.dev being unreachable, answering a status, or serving something that is not JSON were one silence — the same defect the dynamic discovery path was fixed for, left behind on the source that enriches every Anthropic catalog. `ModelsDevFallback.fetch` now takes the same `DiscoveryHooks` as a dynamic fetcher and the manager hands it the caller's `onDiscoveryFailure`, so a reader that can tell those three apart is finally heard. A throw is reported as `unhandled`, because a fetch that throws never reached its own hooks and the fault is on this side rather than the provider's. Specs the manager's rejection gate dropped are reported once per fetch as a `payload` failure, naming them: that is how this source disappears quietly, since drifted fields reject every spec, the enrichment vanishes, and the catalog just looks thin.
- The models.dev refresh drops its timeout timer as soon as the request settles. It armed a bare abort-signal timeout for the full fifteen seconds no matter how fast the answer came back, and a timer that outlives its request is the documented trigger for a crash inside Bun's concurrent collector: the signal fires long after anyone cares, sets an abort reason, and the collector walks it during an unrelated allocation. Discovery against a fast or mocked endpoint is the case that piles them up. The timeout still covers reading the body, not just the response headers, because a stalled body is the failure this deadline exists to bound.

## [1.0.38] - 2026-07-31

### Added

- `DIALECTS` is exported and `Dialect` is derived from it. The union was the only statement of the set, so nothing could enumerate dialects at runtime and a check that wanted to ask whether every dialect ships a format guide had to write the twelve names out a second time.
- `fetchOpenAICompatibleModels` takes an `onFailure` callback and calls it with an `OpenAICompatibleDiscoveryFailure` before returning `null`. Discovery answered a refused connection, a 401, an HTML error page and an unrecognized payload with the same bare `null`, and the caller that keeps per-provider discovery state only reported a reason when discovery THREW, so a model you pay for disappeared from the picker with nothing anywhere explaining it. The reason travels back as a value rather than a log line, because no source file in this package logs and its callers already own the state they report from; `stage` separates the three fixes an operator would reach for, since `request` points at the network, `status` at credentials, and `payload` at whether the endpoint is OpenAI-compatible at all. An empty catalog is still `[]` and still silent.
- Every discovery reader takes the same `onFailure`, and `createModelManager` takes `onDiscoveryFailure` and passes hooks to your `fetchDynamicModels`. `fetchOpenAICompatibleModels` could report a reason but nothing carried one across the manager boundary, and the Codex, Cursor, Devin, Gemini, Antigravity and GitLab Duo readers had no channel at all: they returned a bare `null`. Each lost the reason in a way that mattered. Codex walks two routes and Antigravity walks its fallback endpoints, and both `continue`d past every failure, so an expired token and a retired route ended in the same `null` naming neither attempt. Cursor speaks HTTP/2 directly and had five separate ways to answer `null` with nothing recorded, including the timeout and a non-2xx status. Gemini paginates, so a failure on a later page looked like a rejected key. GitLab Duo reaches a model list through a namespace lookup, a project lookup, a paginated group walk and two GraphQL queries, every one of them silent. Readers that try several endpoints report every attempt, so one `null` can carry several reasons, and a reason can be followed by a success when a later attempt works. A successful catalog reports nothing, including a success that lists no models. Gemini passes its key in the query string, so the reported URL is the keyless one.
- `DEVIN_SESSION_TOKEN_PREFIX` and `normalizeDevinSessionToken` are exported, and `@veyyon/ai`'s Devin provider takes them from here instead of spelling both again. Two packages send that header, so one format had four statements across a package boundary; a disagreement would let model discovery authenticate while every completion 401s, which reads like a broken account rather than a mismatched header.
- `matchesKimiK27CodeFamily` and `hasBillableCost` each have one home. The Kimi K2.7 Code family test lived in both compat layers, id pattern and match, with the second copy documented as mirroring the first: one model-identity rule stated four times, and a drift between them would force thinking on only for whichever transport handled the request. `hasBillableCost` lived in the model generator and again in `@veyyon/stats`, where it decides whether to trust a bundled price, so two functions that only happened to agree were deciding money a user reads. Note what it does not answer: an all-zero cost cannot tell a free model from an unpriced one, which is what `costKnown` is for.
- Added `isEffort`, the guard for a thinking level, beside the `THINKING_EFFORTS` list that owns the values. Callers were spelling the six levels out again in comparison chains, which meant adding a level to the ladder left them rejecting it while the type system accepted it.

### Changed

- `discovery/devin.ts` exports `DEVIN_IDE_VERSION` and `DEVIN_EXTENSION_VERSION`, and `discovery/antigravity.ts` exports `FETCH_AVAILABLE_MODELS_PATH`. All three go on the wire and all three had a second declaration in `@veyyon/ai`, so the catalog was being bypassed rather than read. Devin's two versions are request metadata sent by model discovery here and by the chat provider there, and the two halves of one session identifying themselves as different client builds is the kind of mismatch a provider notices before we do. The Antigravity path is spelled by discovery here and by the usage reader there, and a usage reader that 404s reports no quota information rather than a wrong URL.
- `provider-endpoints.ts` also owns `OPENROUTER_API_ENDPOINT`. The host was declared four times across two packages under three names, and it carries a `/v1` path segment, so an API version bump had four declarations to find. `@veyyon/mnemopi` held three of them, and its embedding path and its extraction path pointing at different versions of the same host is a mismatch that shows up only as a request the endpoint rejects.
- `wire/anthropic.ts` owns `ANTHROPIC_WEB_SEARCH_TOOL`, the server-side tool name that the search provider in `@veyyon/coding-agent` asks for and the Anthropic provider in `@veyyon/ai` matches in the response. A drift between them is a miss rather than an error: the search runs, the results come back, and nothing renders them.
- `provider-endpoints.ts` also owns the Gemini developer API base, Anthropic's official host and Cursor's API host, each of which had a name per package. The Anthropic one is read for two jobs that must agree: it is the fallback base URL, and it is what `compat/anthropic.ts` compares a configured base URL against to decide whether it is talking to Anthropic itself, a check that is exact rather than a prefix test so a lookalike host cannot pass.
- `wire/google-oauth.ts` owns Google's OAuth authorize and token endpoints and the scopes both sign-in flows request. Three modules each had copies: the token endpoint appeared three times under two names, the authorize endpoint twice, and the cloud-platform scope three times. A wrong endpoint fails at once, but a wrong scope succeeds and the token simply lacks the permission, so the failure arrives later as a 403 naming the API rather than the scope that was never granted.
- `wire/perplexity.ts` owns the client identity veyyon presents to Perplexity's consumer endpoints: the web origin, the macOS bundle id, the app User-Agent, its API version, the request header names, and the header pair that says "I am the macOS app". Two packages are two halves of one Perplexity session, `@veyyon/ai` mints the JWT and `@veyyon/coding-agent` spends it, and each had declared the identity itself under its own names. A mismatch between them is not an error: the ask endpoint answers 200 and serves the anonymous free `turbo` model regardless of `model_preference`, so a Pro account gets free-tier answers with nothing saying why.
- `wire/codex.ts` owns the Codex JWT claim namespaces and the reader for them: `CODEX_JWT_AUTH_CLAIM`, `CODEX_JWT_PROFILE_CLAIM`, `readCodexTokenIdentity`, `readCodexClaimsFromPayload`, `getCodexAccountId` and `getCodexAccountEmail`. Five modules across three packages each hand-rolled "decode a ChatGPT OAuth token and pull `chatgpt_account_id` out of it", under three names for the auth claim plus a bare literal. A claim namespace is a lookup key, so a copy that drifts returns `undefined` and a valid token reads as one that carries no account rather than as an error. The empty-claim rule now has one statement: an empty or whitespace-only claim is reported as absent, because the account id becomes the `chatgpt-account-id` header and an empty header value makes the backend answer a malformed-account error instead of using the token's own account. `JWT_CLAIM_PATH` remains as an alias of `CODEX_JWT_AUTH_CLAIM`.
- Devin's three hosts have three names in `provider-endpoints.ts`: `DEVIN_CASCADE_ENDPOINT` for the Cascade chat API, `DEVIN_AUTH_ENDPOINT` for the token API, and `DEVIN_WEBAPP_URL` for the login-approval page. Two of them were previously declared as `DEVIN_API_URL`, the chat host in `@veyyon/ai`'s provider (exported) and the token host in its sibling OAuth flow, so anything reaching for "the Devin API URL" to authenticate would have got the chat host and failed against an endpoint that serves no tokens. The chat host had a third declaration here under `DEVIN_DEFAULT_BASE_URL`.
- The token limits assumed for an agent gateway that does not publish its own live in `discovery/default-limits.ts` as `AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW` and `AGENT_GATEWAY_DEFAULT_MAX_TOKENS`. Antigravity, Cursor and Devin each declared the same 200_000 / 64_000 pair, which is one decision restated three times: all three proxy Claude-class models and report their limits unreliably. `codex.ts` declared 272_000 / 128_000 under the SAME two names, so one name meant two values in one directory, and these numbers drive auto-compaction and the context panel. Codex's pair is now provider-prefixed. GitLab Duo Workflow keeps its own 200_000 on purpose, because its value has an independent reason recorded beside it.
- `src/provider-endpoints.ts` is the one place a provider base URL the code decides is written, and `provider-models/google.ts` and `discovery/gitlab-duo-workflow.ts` read it. Google's Cloud Code host was declared in six modules under four names, the Antigravity daily host in six more under four names plus one bare literal inside a settings switch, and the ordered `[daily, sandbox]` fallback pair in four, once with the sandbox host inline beside its own named constant so a host rotation would have updated the name and missed the literal. `https://gitlab.com` was in five modules across two packages under three names, which is worse than three copies of one name: a grep for any of the three finds nothing, so a reader cannot tell the value is shared. This package already exported two of the hosts from `discovery/antigravity.ts`, but reaching that export costs arktype and the whole discovery machinery, which is exactly why the string kept being retyped instead of imported. The new module has NO imports, so taking a host from it costs one module, and `discovery/antigravity.ts` re-exports its two former names unchanged.
- Every pure helper this package uses comes from the module that owns it rather than from the `@veyyon/utils` barrel: `errorMessage` and `isRecord` from `@veyyon/utils/type-guards`, `trimTrailingSlashes` and `normalizeBaseUrl` from `/url`, `once` from `/abortable`, `fetchWithRetry` from `/fetch-retry`, `wrapFetchForExtraCa` from `/tls-fetch`, `decodeJwtPayload` from `/jwt`. Eleven files each took one or two names and paid 82 modules for them, which put the whole barrel on the graph of anything that read the provider table. `provider-models` is 62 modules instead of 118 and this package's barrel is 128 instead of 186. Nothing about the exports changed.

### Fixed

- `fetchGitLabDuoWorkflowModels` answers `null` when no candidate namespace exposes Duo models, instead of throwing. It was the only reader that threw, and a throw reaches a manager's catch where it is labelled `unhandled`, which claims a bug in the reader when the real answer is that the token sees no namespace with Duo access. The sentence naming which env var to set now arrives as the reported reason. `discoverGitLabDuoWorkflowRuntimeNamespace` still throws, because a runtime that cannot resolve a namespace has to stop.
- Every step of the GitLab Duo handshake now makes its request through one function rather than spelling out its own `try`/`if (!response.ok)`/`try` around `response.json()`. Four copies of the same three-way decision meant four places for it to drift and four places a reason had to be added.
- Fixed GPT-5.6 Codex SKUs (`gpt-5.6-{sol,terra,luna}`) losing ~75K of usable context when the Codex discovery endpoint actively reports `context_window: 272000`: discovery now floors these SKUs at the 372K hard capacity instead of only substituting it when the field is absent, so the runtime dynamic value no longer overwrites the bundled pin ([#6259](https://github.com/can1357/oh-my-pi/issues/6259)).

### Removed

- Removed `remoteCompaction` from model and provider metadata, along with the Codex discovery constant that set it. It configured provider-native compaction, which no longer exists, so nothing has read it for some time while it was still declared on every model and shipped in `models.json`.

## [1.0.24] - 2026-07-24

### Fixed

- OpenRouter pricing is now parsed through `toPositiveNumber` instead of a bare `parseFloat`, so a malformed price is rejected rather than becoming `NaN`.
- Hand-authored thinking-effort ladders are now canonicalized at build time.
- Model compatibility overrides are now applied by own key rather than prototype membership, so an override named after a prototype member is handled correctly.

## [1.0.14] - 2026-07-23

> **Fork notice.** Veyyon is a source fork of oh-my-pi ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), MIT). Every version entry **at or below `16.5.2`** is inherited upstream oh-my-pi release history — not a veyyon release (see [UPSTREAM.md](../../UPSTREAM.md)). Veyyon's own release line starts at **`1.0.0`**.

## [1.0.13] - 2026-07-23

### Fixed

- Devin's effort-suffixed model families now collapse into effort-routed logical models, so their reasoning choice is actually selectable. `claude-5-fable-*` and `claude-sonnet-5-*` (five tiers, low..max), `grok-4-5-*` (low..high), GLM-5.2's `-none` off siblings (off/high/max, 200K and 1M variants), and the legacy `MODEL_CLAUDE_4_5_OPUS`/`_THINKING` pair were bundled as separate dial-less models; `/thinking` had nothing to set on them and `getSupportedEfforts` returned an empty list. Each family is now one logical model whose `thinking.effortRouting` picks the sibling wire id per effort; old persisted suffixed ids resolve to the collapsed family via the variant alias table.
- `xai-oauth` grok-build and grok-build-0.1 now expose the reasoning-effort dial. They were curated `supportsReasoningEffort: false`, which stripped the thinking ladder and silently discarded the user's chosen effort; the models accept the wire `reasoning.effort` param (the plain `xai` provider entries already carried a ladder). `grok-build` joined the Grok effort-capable allowlist; `grok-4.20-0309-reasoning` remains the dial-less reference.
- Cursor's tier-suffixed model ids (`gpt-5.4-low` .. `gpt-5.4-xhigh`, the `gpt-5.2`/`gpt-5.2-codex`/`gpt-5.3-codex` tier siblings) now collapse into effort-routed logical models, and the requested effort actually reaches the wire: Cursor's transport carries no effort field, so effort selects the tier sibling model id. Before this fix the tier ladders were inert; whatever effort you set, the same wire id was requested.
- Cursor discovery now recognizes future tier-suffixed model ids (`gpt-5.4-max`, `composer-1-high`) as their base model at a fixed effort: a tier id with no exact bundled reference inherits the base's reference (reasoning flag, limits, modalities) via a stripped-suffix lookup instead of arriving as an unknown, dial-less model with default metadata.
- Aggregator OpenAI o-series rows (`o1`, `o1-pro`, `o3-mini-high`, `o4-mini-high`, and dated pins on aimlapi, kilo, nanogpt, openrouter) now carry `reasoning: true`. Upstream metadata shipped them as non-reasoning, which hid the thinking dial entirely; the generator now corrects any o-series id whose reasoning flag is false.
- Thinking-pair collapse no longer refuses to pair `X`/`X-thinking` siblings when one side reports a cache price of zero. Aggregators often omit cache pricing on one sibling; a zero cache field now means "not stated" instead of "different price", so pairs like openrouter's `qwen/qwen3-max` and nanogpt's `claude-haiku-4-5-20251001` fold into one model with an off/on thinking route. Pairs with genuinely different nonzero prices still stay separate.
- `requireSupportedEffort` no longer ends its error with an empty `Supported efforts:` list for reasoning models with no controllable effort surface. The message now states that the model exposes no controllable thinking efforts and how to proceed.
