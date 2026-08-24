#!/usr/bin/env bash
# Translate an endpoint served by the recording host into one the recorder
# container can dial.
#
# The capture config requires the model to be served by the machine doing the
# recording: scripts/demos/record-hd-demo.sh refuses a non-loopback
# PROOF_LLM_BASE_URL unless ALLOW_REMOTE_MODEL=1, because every token that
# crosses a network shows up as a pause the recording then blames on the
# product. The container is on a docker bridge, so the loopback address that
# check demands resolves to the container itself and every request lands on a
# closed port inside the sandbox. The route out is the docker host gateway,
# published under a name by `--add-host <alias>:host-gateway`.
#
# Both recorders source this, so the alias and the substitution have one owner.

CONTAINER_HOST_ALIAS=host.docker.internal

# container_endpoint <url> -> the same URL with a loopback host replaced by the
# gateway alias. A non-loopback host, and the empty string, pass through
# unchanged: a URL naming a real host is already reachable from the bridge, and
# an unset endpoint stays unset so the seed's own baseUrl survives.
container_endpoint() {
	printf '%s' "${1:-}" |
		sed -E "s#^([a-z]+://)(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])([:/]|\$)#\1${CONTAINER_HOST_ALIAS}\3#"
}
