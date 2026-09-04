#!/usr/bin/env bash
# veybot container entrypoint. No per-boot pip installs — everything is baked
# into the image; we only sanity-check the runtime mount and create state dirs.
#
# Used by both the orchestrator (CMD: `python -m veybot serve`) and the
# sibling gh-proxy (compose command: `python -m veybot.proxy serve`). The
# proxy role does NOT need a $VEYYON_ROOT veyyon checkout — it never runs veyyon.
set -euo pipefail

# Shared git metadata under /data/workspaces/_pool is intentionally group
# writable by the `veyyon` group so interrupted work can resume on a different
# slot user. Keep new files and directories compatible with that model.
umask 0002

# Detect the proxy role by inspecting the command. Compose passes `command:`
# as $@ here (after tini --), so $1=python, $2=-m, $3=veybot.proxy is the
# canonical shape; we also accept a single concatenated arg for safety.
is_proxy_role=0
if [ "${1:-}" = "python" ] && [ "${2:-}" = "-m" ] && [[ "${3:-}" == veybot.proxy* ]]; then
    is_proxy_role=1
elif [[ "${1:-}" == *"veybot.proxy"* ]]; then
    is_proxy_role=1
fi

/usr/sbin/groupadd -f -g 2000 veyyon
max_slots="${VEYBOT_MAX_CONCURRENCY:-8}"
for i in $(seq 1 "$max_slots"); do
    user="veyyon-$i"
    slot_group="veyyon-$i"
    slot_id=$((2000 + i))
    /usr/sbin/groupadd -f -g "$slot_id" "$slot_group"
    id -u "$user" >/dev/null 2>&1 || /usr/sbin/useradd -u "$slot_id" -g "$slot_group" -G veyyon -M -N -s /usr/sbin/nologin "$user"
    /usr/sbin/usermod -g "$slot_group" -a -G veyyon "$user"
done

if [ "$is_proxy_role" -eq 1 ]; then
    exec "$@"
fi

: "${VEYYON_ROOT:=/work/veyyon}"
if [ ! -d "$VEYYON_ROOT/packages/coding-agent" ]; then
    echo "veybot: VEYYON_ROOT=$VEYYON_ROOT does not look like a veyyon checkout (no packages/coding-agent/)" >&2
    exit 1
fi

mkdir -p /data/workspaces /data/workspaces/_pool /data/logs
# Persistent build caches under the /data volume. CARGO_HOME,
# CARGO_TARGET_DIR, and RUSTUP_HOME are pinned to these paths in the image ENV
# so every per-issue worktree shares one cargo target/toolchain. Bun install
# cache is workspace-private; a shared cache is unsafe across slot users
# because bun may chmod/chown its cache root to the first writer.
mkdir -p /data/cache/cargo /data/cache/cargo-target /data/cache/rustup /data/cache/veyyon-natives
chown -R root:veyyon /data/cache /data/workspaces/_pool
find /data/cache /data/workspaces/_pool -type d -exec chmod 2770 {} +
find /data/cache /data/workspaces/_pool -type f -perm /111 -exec chmod 0770 {} +
find /data/cache /data/workspaces/_pool -type f ! -perm /111 -exec chmod 0660 {} +
chmod 0700 /data/logs


rm -rf /srv/agent-home/.agent /srv/agent-home/.veyyon/agent
mkdir -p /srv/agent-home/.agent /srv/agent-home/.veyyon/agent
if [ -e /srv/agent-home-stage/.agent ]; then
    cp -a /srv/agent-home-stage/.agent/. /srv/agent-home/.agent/
fi
if [ -e /srv/agent-home-stage/.veyyon/agent ]; then
    cp -a /srv/agent-home-stage/.veyyon/agent/. /srv/agent-home/.veyyon/agent/
fi
chown -R root:root /srv/agent-home || true
find /srv/agent-home -type d -exec chmod 0755 {} +
find /srv/agent-home -type f -exec chmod 0644 {} +

# veyyon registers daemon project presence under ~/.veyyon/run at startup, nesting
# per-project dirs (daemons/<hash>/clients) that any slot user must be able to
# create and enter regardless of which slot first made them: setgid + group
# veyyon keeps the whole tree group-writable (entrypoint umask 0002 carries into
# slot processes, so new entries stay group-writable too).
mkdir -p /srv/agent-home/.veyyon/run
chgrp -R veyyon /srv/agent-home/.veyyon/run
chmod -R g+rwX /srv/agent-home/.veyyon/run
find /srv/agent-home/.veyyon/run -type d -exec chmod g+s {} +
chmod 2770 /srv/agent-home/.veyyon/run

touch /data/veybot.sqlite
chown root:root /data/veybot.sqlite
chmod 0600 /data/veybot.sqlite
for db_file in /data/veybot.sqlite-wal /data/veybot.sqlite-shm; do
    if [ -e "$db_file" ]; then
        chown root:root "$db_file"
        chmod 0600 "$db_file"
    fi
done

exec "$@"
