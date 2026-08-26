/**
 * Token limits assumed for an agent-gateway model NOTHING is known about. This pair is the FLOOR, not the
 * answer — `./gateway-limits` reaches the catalog's own entry for the proxied model first. Claude-class
 * because that is what these gateways mostly proxy. Not a global default: `codex.ts` (272k/128k),
 * `gitlab-duo-workflow.ts` (200k, independent reason), and `openai-compat.ts` (128k/32k) each keep their own.
 * No imports.
 */

/**
 * Context window assumed for a gateway model the catalog cannot identify at all: 200k, the Claude-class window.
 *
 * A guess that is too LOW is the safe direction. Auto-compaction and the context panel both read this number, so
 * an over-estimate means the agent keeps filling a window the model does not have and the provider rejects the
 * request, while an under-estimate only compacts earlier than it needed to. That is also why it stays the floor
 * for an unknown id rather than being raised: an unknown id is exactly the case with no evidence either way.
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
