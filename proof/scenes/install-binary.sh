#!/usr/bin/env bash
# The install line from the README, run against the published release.
#
# The row claims one verified download and a working binary, so the recording is the
# real installer fetching the real release over the network: `curl -fsSL
# https://get.veyyon.dev | sh` resolves the platform, downloads the binary and its
# checksum sidecar, fails closed on a mismatch, links the `vey` alias and reports
# where it put both. Nothing about it is staged -- the container's HOME is a tmpfs, so
# the install lands in a home that exists for the length of the recording.
#
# The PATH line is in the recording on purpose: a fresh install adds a directory the
# shell already running has not read, the installer says so, and a row that hid that
# step would be a row of a product that installs differently than it does.
#
# The terminal runs a shell for this scene rather than the app, and the last thing it
# does is start the installed binary in the demo project, because the question an
# install row answers is whether the thing that arrives runs.
#
# Typed at 70ms a character rather than the default 28. One take of this row came out
# with doubled characters in the URL and the variable ("get.veyyonn.dev", "$HHOME"), so
# nothing ran and the recording was four command lines with no output under them. A
# shell scene has no model latency to hide behind, so the slower typing costs the row
# a few seconds and nothing else.
TYPE_DELAY=70

settle 6
shot idle

submit "curl -fsSL https://get.veyyon.dev | sh"
settle 60
shot installed

# The scene runs in the same container as the shell it is typing at, so it can check
# the claim rather than hope: an install that did not land must not be published as a
# recording of an install.
if [ ! -x /sandbox/home/.local/bin/vey ]; then
	echo "scene install-binary: the installer left no executable at ~/.local/bin/vey" >&2
	exit 1
fi

submit "export PATH=\"\$HOME/.local/bin:\$PATH\" && vey --version"
settle 12
shot version

submit "vey --help | head -28"
settle 10
shot help

# The model is named on the command line, as every other row names it, because a
# launch that names none took the first local row in the catalog rather than the value
# in the machine config, and an install row carrying a different model chip than the
# rest of the gallery reads as a different product.
submit "cd ~/demo && vey --model local/demo-qwen3-32b-32k"
settle 45
shot launched

# The row ends here, on the installed binary running. The first take went on to submit
# `/exit` and recorded a cleared session instead of a shell, which is a worse last
# frame than the one the row exists for.
