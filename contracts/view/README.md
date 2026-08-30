# @veyyon/view

The view model a Veyyon tool returns instead of a terminal component.

A tool that builds a terminal component runs only in a terminal. A tool that returns a `ToolView`
states what its output means and leaves the appearance to whichever host is drawing: the terminal, a
browser client, or a graphical front end. The package has no dependencies.

## Exports

```ts
import type {
  StatusRowView,
  TextBlockView,
  ToolView,
  ToolViewRenderer,
  ViewSpan,
  ViewStatus,
  ViewTone,
} from "@veyyon/view";
```

## Model

- `ViewStatus` — what the tool reports about its own state: `success`, `done`, `error`, `warning`,
  `info`, `pending`, `running`, `aborted`. The host picks the glyph and whether `running` animates.
- `ViewTone` — the role a run of text plays: `title`, `accent`, `muted`, `dim`, `success`, `warning`,
  `error`, `info`. The host maps a tone to a colour or a class.
- `ViewSpan` — a run of text with one tone, optionally bold or italic.
- `StatusRowView` — a one-line summary: status, title, description, badge, trailing metadata. The host
  owns the separators.
- `TextBlockView` — a run of styled spans, wrapped by the host.
- `ToolViewRenderer` — `renderCall` and `renderResult`, each taking only the tool's own data.

## Writing a renderer

```ts
import type { ToolViewRenderer } from "@veyyon/view";

const renderer: ToolViewRenderer<{ name: string }, { text: string }> = {
  renderCall: args => ({
    kind: "statusRow",
    title: "init_experiment",
    titleTone: "title",
    meta: [{ text: args.name, tone: "accent" }],
  }),
  renderResult: result => ({
    kind: "textBlock",
    spans: [{ text: result.text }],
  }),
};
```

No host type appears in the renderer, which is what lets a gate check it: a renderer that needs a
theme to answer cannot implement this interface.
