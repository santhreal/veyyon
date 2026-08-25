#!/usr/bin/env bash
# Files → LSP is one parent row. With language servers off, entering it shows
# only the master switch; with `lsp.enabled: true`, the same action opens the
# complete nested page.
settle 16
submit "/settings"
settle 4

# Search for the parent row in both arms, then enter the same nested page. The
# panel contents prove the dependent controls are absent while off and present
# while on.
t "language servers"
settle 3
shot lsp-search
k Escape
settle 1
k Return
settle 3
shot lsp-panel
