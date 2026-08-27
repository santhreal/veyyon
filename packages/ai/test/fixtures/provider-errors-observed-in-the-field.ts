/**
 * Every distinct provider failure a real session recorded, with what recovery must do about it.
 *
 * These are field inputs, not invented ones: each `message` is the text a session store held,
 * sanitized. Nobody would invent `503 {"type":"error","error":{"type":"overloaded_error",...}}`
 * with the word `Authentication` inside a transient body, and that is the input that walled a turn
 * the server had explicitly asked to retry.
 *
 * SANITIZATION. Absolute paths, request and trace ids, reset timestamps and account identifiers are
 * replaced with neutral constants of the same shape, so the parser under test still sees a
 * well-formed value. What reproduces a defect here is the SHAPE of the message — where the status
 * sits, which word appears next to which code — never whose account produced it.
 *
 * `verdict` states what the failure IS, decided from the failure and not from what the classifier
 * currently answers: a server that reports 5xx or drops a stream can be asked again, and a quota,
 * a credential wall or a content verdict returns the same answer to the same request.
 *
 * IT NAMES ONE STAGE: the provider ladder, a seconds-scale backoff against the same credential and
 * the same request. `wall` means that ladder stops and reports, which is not the same as the turn
 * being lost — a malformed tool call is `wall` here and is re-sent by the turn one level up, where
 * the recovery for it lives. Recording the stage matters because the two answers differ for a whole
 * family, and a corpus that blurred them would assert the wrong one for every member of it.
 */

/** One failure class, as a session recorded it. */
export interface ObservedProviderError {
	/** The sanitized message text. */
	readonly message: string;
	/** What the provider ladder must do: try again, or stop and report. */
	readonly verdict: "retry" | "wall";
	/** Why that is the right answer for this failure. */
	readonly why: string;
}

export const OBSERVED_PROVIDER_ERRORS: readonly ObservedProviderError[] = [
	{
		message: "OpenAI completions stream closed before a terminal finish reason was received",
		verdict: "retry",
		why: "The stream stopped early, so the bytes on hand are not an answer and the request can be sent again.",
	},
	{
		message: "Cloud Code Assist stream ended without a finish reason (connection dropped or response truncated)",
		verdict: "retry",
		why: "The same truncated stream as above, worded by a different provider.",
	},
	{
		message: "Cloud Code Assist API returned an empty response",
		verdict: "retry",
		why: "A response with no body at all is the degenerate truncation: nothing arrived, so nothing was decided.",
	},
	{
		message: "Provider finish_reason: network_error",
		verdict: "retry",
		why: "The provider named the transport as the thing that failed.",
	},
	{
		message: "Anthropic stream error (overloaded_error): Overloaded",
		verdict: "retry",
		why: "A server reporting its own load is asking for a later attempt.",
	},
	{
		message:
			'503 {"type":"error","error":{"type":"overloaded_error","message":"Authentication service is temporarily unavailable. Retry the request."},"request_id":"req_sanitized"}',
		verdict: "retry",
		why: "A 503 the server asked us to retry. The word `Authentication` in the body describes which service was busy, not a verdict on the credential.",
	},
	{
		message: "500 Internal server error\nInternal server error (type=error)",
		verdict: "retry",
		why: "A 5xx is the server stating it failed.",
	},
	{
		message:
			"503 Error from provider (Console Go): Upstream request failed: Endpoint is unavailable.\nError from provider (Console Go): Upstream request failed: Endpoint is unavailable.",
		verdict: "retry",
		why: "An upstream that was unreachable this second may be reachable the next.",
	},
	{
		message: "Stream closed with error code NGHTTP2_INTERNAL_ERROR",
		verdict: "retry",
		why: "An HTTP/2 INTERNAL_ERROR is the peer resetting one stream, not refusing the request.",
	},
	{
		message: "Codex websocket transport error: websocket closed (1006)",
		verdict: "retry",
		why: "WebSocket 1006 is an abnormal closure: the socket died without a close frame.",
	},
	{
		message:
			"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
		verdict: "retry",
		why: "A dead socket says nothing about the request.",
	},
	{ message: "Connection error.", verdict: "retry", why: "The connection failed with nothing else to read." },
	{
		message: "getaddrinfo ETIMEOUT chatgpt.com",
		verdict: "retry",
		why: "DNS resolution timed out; the name may resolve on the next attempt.",
	},
	{
		message: "OpenAI completions stream timed out while waiting for the first event",
		verdict: "retry",
		why: "A first-event stall is a timing failure, and the next attempt can differ.",
	},
	{
		message: "Provider stream timed out while waiting for the first event",
		verdict: "retry",
		why: "The generic first-event watchdog, for a provider that runs no ladder of its own.",
	},
	{
		message: "OpenAI completions stream stalled while waiting for the next event",
		verdict: "retry",
		why: "A mid-stream stall is the same timing failure after the first event.",
	},
	{
		message: "Anthropic stream stalled while waiting for the next event",
		verdict: "retry",
		why: "The same stall, worded by another provider.",
	},
	{
		message: "OpenAI Codex SSE stream stalled while waiting for the next event",
		verdict: "retry",
		why: "The same stall over SSE.",
	},
	{
		message: "Error Code unknown: Internal error during token generation",
		verdict: "retry",
		why: "The provider failed inside generation and named no verdict on the request.",
	},
	{
		message: "Generation failed with finish reason: MALFORMED_FUNCTION_CALL",
		verdict: "wall",
		why: "The provider ladder stops, because re-sending the identical request to the identical model reproduces the same unparseable call. The turn resends it a level up, where the model can emit a different one, and that replay is safe because nothing ran.",
	},
	{
		message:
			"Thinking loop detected: the model repeated near-identical content (4 near-identical segments within the last 16). Treating as a stream stall and retrying.",
		verdict: "retry",
		why: "The repetition detector ends the turn in order to send it again; the sentence states the recovery it wants.",
	},
	{
		message: "Generation failed with finish reason: PROHIBITED_CONTENT",
		verdict: "wall",
		why: "A content verdict. The same request gets the same answer, so a retry only spends the quota.",
	},
	{
		message: "Provider finish_reason: sensitive",
		verdict: "wall",
		why: "A content verdict spelled as a finish reason.",
	},
	{
		message:
			"Codex error event: This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. To get authorized for security work, join the Trusted Access for Cyber program: https://chatgpt.com/cyber (code=cyber_policy)",
		verdict: "wall",
		why: "A policy refusal carrying its own code. Retrying re-asks a question already answered.",
	},
	{
		message:
			'403 {"error":{"type":"permission_error","message":"You\'ve reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle."}}',
		verdict: "wall",
		why: "An account-level cap. Waiting seconds changes nothing; the credential is the thing that has to change.",
	},
	{
		message:
			"403 You have run out of credits or need a Grok subscription. Add credits at https://example.invalid/usage or upgrade at https://example.invalid/upgrade.",
		verdict: "wall",
		why: "An exhausted balance is a wall until somebody pays.",
	},
	{
		message: "Connect error resource_exhausted: Error",
		verdict: "wall",
		why: "The account's allowance is gone, so the same credential gets the same answer.",
	},
	{
		message:
			"429 Rate limit exceeded. Please try again later. retry-after-ms=50352000\nRate limit exceeded. Please try again later. (type=FreeUsageLimitError)",
		verdict: "wall",
		why: "A retry-after of fourteen hours is a cap, whatever the sentence beside it suggests.",
	},
	{
		message:
			"429 5-hour usage limit reached. Resets in <duration>. To continue using this model now, enable usage from your available balance.",
		verdict: "wall",
		why: "A windowed cap that a seconds-scale ladder cannot wait out.",
	},
	{
		message:
			'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."},"request_id":"req_sanitized"}',
		verdict: "wall",
		why: "An account rate limit, which rotates a credential rather than retrying one.",
	},
	{
		message:
			'Cloud Code Assist API error (429): {\n  "error": {\n    "code": 429,\n    "message": "Individual quota reached. Please upgrade your subscription to increase your quota."\n  }\n}',
		verdict: "wall",
		why: "A per-account quota naming the upgrade as the remedy.",
	},
	{
		message:
			"400 Error from provider (Console): Upstream request failed: Model is unavailable.\nError from provider (Console): Upstream request failed: Model is unavailable.",
		verdict: "wall",
		why: "A 4xx naming the model as the thing that is gone. Re-sending the same request to the same model reproduces it.",
	},
];

/**
 * The failures that carry no classification on purpose, pinned by exact equality.
 *
 * `Previous veyyon process exited before completing the turn.` is this product's own resume marker
 * rather than a provider failure: no ladder can recover a process that is not running, and the
 * message exists to tell the operator what happened to the last turn.
 *
 * Anything else that reaches the corpus unclassified is a gap, and the suite says so by name.
 */
export const UNCLASSIFIED_BY_DESIGN: readonly string[] = ["Previous veyyon process exited before completing the turn."];
