#!/usr/bin/env bash
# Build outputs the product imports at PARSE time, materialized before a take
# starts.
#
#   source proof/docker/session-artifacts.sh && ensure_session_artifacts
#
# WHY THIS FILE EXISTS. `packages/coding-agent/src/export/html/index.ts` imports
# the gitignored `tool-views.generated.js` with `{ type: "text" }`, which Bun
# resolves when the module is parsed. A worktree without it starts the terminal,
# the CLI dies in the first second with "Cannot find module", the terminal exits
# with its child, and the display goes back to an empty root.
#
# Nothing in the capture path said so. ffmpeg recorded a black screen, the stills
# came out as uniform PNGs, and the scene abandoned the take reporting that one
# shot was byte-identical to the previous one, which reads like a scene that
# pressed a key too early. Three takes and two hosts were spent on that message.
# scripts/demos/record-hd-demo.sh already guarded the artifact; the scene
# recorders did not, so the guard now has one home both session entry points
# reach.
#
# It runs inside the container, where bun is on PATH and /repo is the checkout,
# and it fails closed: a take is worth less than nothing when the product it
# photographs never ran.
ensure_session_artifacts() {
	local repo="${1:-/repo}"
	local bundle="${repo}/packages/coding-agent/src/export/html/tool-views.generated.js"
	[ -s "${bundle}" ] && return 0
	echo "session: generating the missing build artifact (${bundle##*/})" >&2
	if ! (cd "${repo}" && bun --cwd=packages/collab-web run gen:tool-views >&2); then
		echo "session: could not generate ${bundle##*/}; the product would exit at parse time" >&2
		return 1
	fi
	[ -s "${bundle}" ] || {
		echo "session: the generator reported success and wrote no ${bundle##*/}" >&2
		return 1
	}
}
