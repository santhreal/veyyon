/**
 * The token limits assumed for an agent-gateway endpoint that does not publish its own.
 *
 * Several providers here are gateways rather than model hosts: Antigravity, Cursor and Devin each expose a
 * catalog of models they proxy, and none of them reports a context window or an output cap you can rely on.
 * Cursor reports nothing at all, Devin reports one number that has to serve as both, and Antigravity reports
 * fields that are frequently absent. Every one of those endpoints proxies Claude-class models, so the assumption
 * is a Claude-class pair: a 200k context window and a 64k output cap.
 *
 * WHY THIS IS ONE DECISION AND NOT THREE COINCIDENCES. All three modules also carry the same comment about
 * pricing, that the zeros mean "not told" rather than "free", because they are the same KIND of endpoint with the
 * same gaps. The limits follow from that, so raising the assumption when the proxied model class changes is one
 * judgement, and it should be one edit. Three copies meant a reader could not tell whether the three modules
 * agreed on purpose.
 *
 * WHAT THIS IS NOT. It is not a global default for every provider, and the name says gateway so nobody reaches
 * for it as one:
 *
 * - `codex.ts` assumes 272k / 128k, because GPT-5-class Codex is a different model class with a documented
 *   under-reporting quirk. It used to declare that pair under the bare names `DEFAULT_CONTEXT_WINDOW` and
 *   `DEFAULT_MAX_TOKENS`, which is what three of its siblings called 200k / 64k. One name meaning two values in
 *   one directory is a latent bug, not a style point, so its constants are now prefixed with the provider.
 * - `gitlab-duo-workflow.ts` also assumes 200_000, and deliberately keeps its own constant. Its value has an
 *   independent reason recorded beside it, the Duo Workflow Service's own global fallback in
 *   `duo_workflow_service/conversation/trimmer.py`, so the match is a coincidence. Folding it in here would tie
 *   two unrelated decisions together, and the next person to change the gateway assumption would silently move
 *   GitLab away from the number its upstream actually uses.
 * - `provider-models/openai-compat.ts` assumes 128k / 32k for generic OpenAI-compatible discovery, already under
 *   provider-prefixed exported names.
 *
 * This module has no imports, so a discovery module pays nothing to read the pair.
 */

/**
 * Context window assumed for a gateway that does not report one: 200k, the Claude-class window.
 *
 * A guess that is too LOW is the safe direction. Auto-compaction and the context panel both read this number, so
 * an over-estimate means the agent keeps filling a window the model does not have and the provider rejects the
 * request, while an under-estimate only compacts earlier than it needed to.
 */
export const AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Output cap assumed for a gateway that does not report one: 64k.
 *
 * Kept well below the context window because it is an output budget rather than a share of the window, and a
 * request asking for more output than the model will produce is refused outright by some gateways rather than
 * clamped.
 */
export const AGENT_GATEWAY_DEFAULT_MAX_TOKENS = 64_000;
