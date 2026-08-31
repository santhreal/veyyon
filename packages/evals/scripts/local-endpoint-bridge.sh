#!/usr/bin/env bash
# Publish a host-served model endpoint on a port a container's egress policy permits.
#
# A trial container runs under the task's network policy. Pier and Harbor filter egress
# through a proxy that allows one destination list on ports 80 and 443 only, so an
# endpoint on 127.0.0.1:1234 is unreachable from a trial twice over: the address is the
# container's own loopback, and the port is refused. This forwards the docker bridge
# address on port 80 to the host endpoint, which is the address and port the eval
# harness hands the container (see engine/local-inference-endpoint.ts).
#
# The listener is a container, so publishing a privileged port needs no sudo: the docker
# daemon owns the bind. Reaching the host endpoint from inside it needs the host firewall
# to accept the bridge subnets on the endpoint's port.
#
# The endpoint is served by the docker host by default. ENDPOINT_HOST names another host
# instead, which is what a run whose trials execute on one machine and whose model is
# served by another needs: the container-side address stays 172.17.0.1:80, so nothing the
# harness hands the container changes.
#
# Usage: local-endpoint-bridge.sh up [endpoint-port] | down | status
#        ENDPOINT_HOST=<host> local-endpoint-bridge.sh up [endpoint-port]

set -euo pipefail

NAME=veyyon-eval-local-endpoint-bridge
BRIDGE_ADDRESS=172.17.0.1
SAFE_PORT=80
IMAGE=alpine/socat:latest

endpoint_port="${2:-1234}"
endpoint_host="${ENDPOINT_HOST:-$BRIDGE_ADDRESS}"

case "${1:-status}" in
up)
	if [ -n "$(docker ps -q -f "name=^${NAME}$")" ]; then
		echo "already up: ${BRIDGE_ADDRESS}:${SAFE_PORT} -> ${endpoint_host}:${endpoint_port}"
		exit 0
	fi
	docker rm -f "${NAME}" >/dev/null 2>&1 || true
	docker run -d --restart unless-stopped --name "${NAME}" \
		-p "${BRIDGE_ADDRESS}:${SAFE_PORT}:${SAFE_PORT}" \
		"${IMAGE}" \
		"TCP-LISTEN:${SAFE_PORT},fork,reuseaddr" "TCP:${endpoint_host}:${endpoint_port}" >/dev/null
	for _ in $(seq 30); do
		if curl -fsS -m 2 -o /dev/null "http://${BRIDGE_ADDRESS}:${SAFE_PORT}/v1/models"; then
			echo "up: ${BRIDGE_ADDRESS}:${SAFE_PORT} -> ${endpoint_host}:${endpoint_port}"
			exit 0
		fi
		sleep 1
	done
	echo "REFUSED: ${BRIDGE_ADDRESS}:${SAFE_PORT} does not answer /v1/models." >&2
	echo "Check ${endpoint_host} serves the endpoint on 0.0.0.0:${endpoint_port}. When it is" >&2
	echo "this host, its firewall also has to accept the docker subnets on that port:" >&2
	echo "  sudo ufw allow from 172.16.0.0/12 to any port ${endpoint_port} proto tcp" >&2
	docker logs --tail 20 "${NAME}" >&2 || true
	exit 1
	;;
down)
	docker rm -f "${NAME}" >/dev/null 2>&1 || true
	echo "down"
	;;
status)
	if [ -n "$(docker ps -q -f "name=^${NAME}$")" ]; then
		curl -fsS -m 2 -o /dev/null "http://${BRIDGE_ADDRESS}:${SAFE_PORT}/v1/models" &&
			echo "up and answering" ||
			{ echo "container running, endpoint silent" >&2; exit 1; }
	else
		echo "down" >&2
		exit 1
	fi
	;;
*)
	echo "usage: local-endpoint-bridge.sh up [endpoint-port] | down | status" >&2
	exit 2
	;;
esac
