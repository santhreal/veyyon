#!/usr/bin/env bash
# Late diagnostics rendering proof: exercises grouped transcript rendering,
# home-path shortening (~/...), and global tool-output expansion (ctrl+o).
#
# Driven by a synthetic persisted session seeded into the default profile
# session store with late diagnostic messages (errors, warnings, info, and
# unmatched compiler lines across multiple files).
#
# States:
#   1. collapsed: initial render shows grouped files, severity badges,
#      shortened home paths, and "… 4 more" overflow disclosure.
#   2. expanded: after global tool-output expand (ctrl+o), reveals all
#      diagnostics across all files and unmatched compiler lines.

# Settle on load so the reconstructed session transcript is fully drawn.
settle 16

# Verify the late diagnostics card is present in the transcript.
expect_screen "Late diagnostics" 30

# Verify home-path shortening expectation per arm.
# needle-source: ~/demo/src/parser.ts -- shortened home path in after arm
# needle-source: parser.ts -- unshortened file name in before arm
if [ "${SCENE_ARM:-after}" = "after" ]; then
	expect_screen "~/demo/src/parser.ts" 30
else
	expect_screen "parser.ts" 30
fi

# Assert collapsed overflow disclosure before taking collapsed shot.
# needle-source: … 4 more -- overflow disclosure in collapsed state
expect_screen "… 4 more" 30

# Initial collapsed state: first 5 diagnostics visible, remaining held back.
shot collapsed

# Toggle global tool output expansion via app.tools.expand (default: ctrl+o).
k ctrl+o
settle 4

# Assert expanded final diagnostic (ConfigStore) and unmatched compiler trace before shot.
# needle-source: ConfigStore -- diagnostic type name in expanded state
# needle-source: detailed diagnostic trace -- unmatched diagnostic in expanded state
expect_screen "ConfigStore" 30
expect_screen "detailed diagnostic trace" 30

# Expanded state: all diagnostics and unparsed compiler output revealed.
shot expanded

# Restore collapsed state before ending scene.
k ctrl+o
settle 2
