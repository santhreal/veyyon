import { emptyArmResult } from "../../../suites/deep-swe/aggregate/empty-result";
import type { ArmResult } from "../../../suites/deep-swe/aggregate/types";

/**
 * Build an ArmResult with sane defaults, overriding only what a test cares about.
 *
 * Built from the same `emptyArmResult` the runner uses, deliberately. A private
 * copy of the blank shape would let the fixture keep a field the production
 * factory had dropped, so the suite would still exercise data the real pipeline
 * no longer produces.
 */
export function res(over: Partial<ArmResult>): ArmResult {
	return { ...emptyArmResult("a", "t", 0), ...over };
}

/**
 * Verbatim lines from a real job log, `runs/2026-07-25T19-51-41-474Z/jobs/
 * baseline__scriggo-method-declarations/job.log`, kept as bytes rather than
 * paraphrased.
 */
export const KILLED_MID_RUN_JOB_LOG = [
	'  File "/home/user/.local/share/uv/tools/datacurve-pier/lib/python3.14/site-packages/pier/cli/jobs.py", line 149, in _handle_sigterm',
	"    raise KeyboardInterrupt",
	"KeyboardInterrupt",
	"",
	"asyncio.exceptions.CancelledError",
	"",
	'  File "/home/user/.local/share/uv/tools/datacurve-pier/lib/python3.14/site-packages/pier/trial/artifact_handler.py", line 195, in _download_artifact',
	"RuntimeError: Docker compose command failed for environment datacurve/scriggo-method-declarations.",
	"Error response from daemon: Could not find the file /logs/artifacts/model.patch in container 90cc95e883d14c6ce5ae00d9259a9c8c3df39cabd001e05990e599ae38a6e49d",
].join("\n");

/**
 * The same teardown failure with nothing above it: the agent exited under its own
 * power and simply wrote no patch.
 */
export const FINISHED_WITHOUT_PATCH_JOB_LOG = [
	'  File "/home/user/.local/share/uv/tools/datacurve-pier/lib/python3.14/site-packages/pier/trial/artifact_handler.py", line 195, in _download_artifact',
	"RuntimeError: Docker compose command failed for environment datacurve/scriggo-method-declarations.",
	"Error response from daemon: Could not find the file /logs/artifacts/model.patch in container 90cc95e883d14c6ce5ae00d9259a9c8c3df39cabd001e05990e599ae38a6e49d",
].join("\n");

/**
 * The real 429 payload, verbatim from
 * `runs/2026-07-25T20-46-08-607Z/jobs/sig-last1__ytt-jsonpath-query-api`'s agent
 * log. Kept as bytes because every field the predicate extracts is nested
 * somewhere non-obvious in it: the reset timestamp lives under `details[].
 * metadata`, not beside the message, and the model name sits in the same bag.
 */
export const QUOTA_429_AGENT_LOG = `Working...
Cloud Code Assist API error (429): {
  "error": {
    "code": 429,
    "message": "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h26m55s.",
    "status": "RESOURCE_EXHAUSTED",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "QUOTA_EXHAUSTED",
        "domain": "cloudcode-pa.googleapis.com",
        "metadata": {
          "quotaResetTimeStamp": "2026-07-25T23:50:11Z",
          "uiMessage": "true",
          "model": "gemini-3-flash-agent",
          "quotaResetDelay": "2h26m55.663141191s"
        }
      }
    ]
  }
}`;
