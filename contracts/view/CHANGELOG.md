# Changelog

> **Fork notice.** Veyyon is a source fork of oh-my-pi ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), MIT). Veyyon's own release line starts at **`1.0.0`**.

## [Unreleased]

### Added

- `@veyyon/view` states the host-agnostic tool view model: `ToolView`, `StatusRowView`, `TextBlockView`, `ViewSpan`, `ViewTone`, `ViewStatus` and `ToolViewRenderer`. A tool returning one of these describes its output without importing a terminal component or receiving a theme, so any host can draw it. The package has no dependencies.
- `ToolViewContext` states the disclosure state a host passes to a view renderer, so a tool can show a shorter summary collapsed and its full output expanded without naming a host.
- `FramedBlockView` states a framed panel: a `StatusRowView` header, an optional `ViewStatus` the host reads for the rail colour, and `ViewSection`s of `ViewLine`s, so a tool describes a card without negotiating a width.
- `StatusRowView.emblem` names a symbol a host resolves from its own registry, falling back to the row's status icon when the host has no such symbol.
- `ToolViewRenderer.renderResult` receives the call arguments alongside the result, so a card whose header states the operation still states it when the call failed and returned no details.
- `ViewSpan.symbol` names a symbol a host resolves from its own registry for one span inside a line, drawn in that span's tone; `text` is what a host without such a symbol draws instead.
- `HeadedBlockView` states a frameless card: an optional `StatusRowView` header, `ViewLine`s under it, and a `ViewHiddenCount` naming what a preview held back, so a terse tool card describes its rows without picking an indent, a width or the gesture that reveals the rest.
- `ViewTone` carries an `output` tone for text the tool itself produced, so a card that shows tool output states that rather than reaching for a colour name.
- `ViewSpan.link` and `StatusRowView.descriptionLink` name a target a run of text points at, so a card states where a URL leads without writing a terminal escape sequence, and `ViewTone` carries a `link` tone for text that is a target.
- `ViewSection.hidden` states what a section held back as a `ViewHiddenCount`, so a framed card discloses the rows it did not draw the same way a headed card already did.
- `FramedBlockView.contents` distinguishes a card whose body is a status report from one whose body is fetched data, so a host paints the outcome across a report and leaves fetched content on its own ground.
- `NoticeView` states a short notice whose whole body carries one state — a headline, an optional tag and lines under it — so a tool describes a decision without filling a plate itself; a span inside a notice states emphasis and structure, never colour.
- `ToolViewContext.partial` states whether the result in hand is the tool's last word or an update it will replace, so a card that streams reports running rather than reading an outcome off a half-finished result.
- `ViewSection.tail` states that a section is a window onto the end of its lines, measured by the host in the rows the lines occupy after wrapping, so a tool that cannot know a width or a viewport height still keeps the end of a long command or a long output on screen.
- `ViewSpan.trailing` states that a run is trailing detail on its line, so a host with columns to spare places it at the line's end and pads the runs that lead it, and a host drawing one column after another writes it where it falls.
