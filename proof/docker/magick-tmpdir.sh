#!/usr/bin/env bash
# Scope ImageMagick's named magick-* pixel-cache files to a directory the caller
# deletes. ImageMagick 6's convert, import and magick spill a pixel cache to disk
# as magick-* names when an operation will not fit in RAM (a blurred 2560x1440
# backdrop, a 20k-px test PNG). On a clean exit those names are unlinked; SIGKILL
# leaves them. Unscoped they land in /tmp and exhaust inodes. This never sweeps
# /tmp: it names a directory we own, and the caller removes that directory.
#
#   source proof/docker/magick-tmpdir.sh
#   magick_tmpdir_scope <parent-dir>
#   magick_tmpdir_release   # from the caller's existing EXIT handler
#
# magick_tmpdir_scope is idempotent for a single shell: a second call is a no-op
# so a session script and a publish script can both source this.

magick_tmpdir_scope() {
	local parent="${1:?magick_tmpdir_scope <parent-dir>}"
	if [ -n "${MAGICK_SCOPED_TMPDIR:-}" ] && [ -d "${MAGICK_SCOPED_TMPDIR}" ]; then
		return 0
	fi
	mkdir -p "${parent}"
	MAGICK_SCOPED_TMPDIR="$(mktemp -d "${parent}/veyyon-magick.XXXXXX")"
	export MAGICK_SCOPED_TMPDIR
	export MAGICK_TMPDIR="${MAGICK_SCOPED_TMPDIR}"
	export MAGICK_TEMPORARY_PATH="${MAGICK_SCOPED_TMPDIR}"
}

magick_tmpdir_release() {
	if [ -n "${MAGICK_SCOPED_TMPDIR:-}" ]; then
		rm -rf "${MAGICK_SCOPED_TMPDIR}"
		unset MAGICK_SCOPED_TMPDIR
		unset MAGICK_TMPDIR
		unset MAGICK_TEMPORARY_PATH
	fi
}
