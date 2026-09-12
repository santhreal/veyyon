# @veyyon/gui-host

Draws the Veyyon view contract as HTML.

A tool returns a `ToolView` from `@veyyon/view`. The terminal draws it as rows of escape bytes; this
package draws the same model as elements a stylesheet lays out. Neither host is named by the tool,
and the two share no code.

## Install

The package is part of the Veyyon workspace and is not published.

## Use

```ts
import { drawToolView, guiToolRenderer } from "@veyyon/gui-host";

const html = drawToolView({ kind: "statusRow", status: "success", title: "Read", description: "src/app.ts" });
```

`guiToolRenderer` takes a plugin's own `ToolViewRenderer` and returns the two card halves as HTML,
which is the terminal's `viewToolRenderer` with a different output type and the same input.

## Appearance

Nothing here states a colour. A tone draws as a `v-tone-*` class and a status as a `v-status-*`
class, and the structure a stylesheet lays out arrives as data attributes: `data-status`,
`data-side` on a change row, `data-depth`, `data-opens` and `data-last` on a tree row,
`data-language` on source, and `data-live` on anything still in flight.

A symbol, emblem or notice mark key draws the glyph `UNICODE_SYMBOLS` in `@veyyon/view` holds for
it, the same table the terminal's plain preset and the HTML export draw from. An embedder overrides
a glyph through `GuiViewOptions.symbols`, keyed by the symbol and emblem names a tool states and by
`status:<name>` for the mark a status draws. A key in neither table draws the span's own text, no
emblem and no notice mark; the key itself is never text.
Only own properties of the symbol table are resolved; inherited names fall through to the shared table.
Symbol values from `GuiViewOptions.symbols` are inserted as markup; glyphs from the shared table are escaped as text.

## What this host answers differently from the terminal

- `ViewTailWindow.viewport` and `reserve` describe a terminal's remaining screen. A document
  scrolls, so this host honours the tool's own `max` and ignores those two.
- `ViewSection.clip` marks the row and leaves the cut to the stylesheet, which is the only party
  that knows the width.
- `ViewSpan.captured` keeps the words another program wrote and drops every control sequence, since
  there is no screen to replay them onto.
