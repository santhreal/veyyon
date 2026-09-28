//! Drawing the `ToolView` model: a tool's own presentation of its call or its
//! result, and a recorded message that is neither a prompt nor a reply.
//!
//! Every variant draws: a status row, a text block, a headed block, a framed
//! block with its sections (code, diff, tree, list), and a notice. A span the
//! host marks `captured` is terminal output and is drawn with its control
//! sequences removed. A span that links opens through the host.

use gpui::{AnyElement, App, Entity, Hsla, SharedString, div, prelude::*};
use veyyon_desktop_model::{
	HostAction, SurfaceId,
	tool_view::{
		FramedBlockView, HeadedBlockView, NoticeView, StatusRowView, ToolView, ViewDiffSide,
		ViewHiddenCount, ViewLine, ViewSection, ViewSpan, ViewStatus, ViewTone,
	},
};
use veyyon_desktop_ui::theme::{ActiveTheme, Palette, TypeStyled, radius, space, text};

use super::values::sanitize;
use crate::AppState;

/// The color `tone` draws in.
#[must_use]
pub const fn tone_color(tone: ViewTone, palette: &Palette) -> Hsla {
	match tone {
		ViewTone::Title | ViewTone::Text => palette.text.primary,
		ViewTone::Accent => palette.accent.base,
		ViewTone::Output | ViewTone::Cost => palette.text.secondary,
		ViewTone::Link | ViewTone::Info => palette.status.info,
		ViewTone::Muted => palette.text.muted,
		ViewTone::Dim => palette.text.faint,
		ViewTone::DiffAdded => palette.diff.add_fg,
		ViewTone::DiffRemoved => palette.diff.del_fg,
		ViewTone::Success => palette.status.success,
		ViewTone::Warning => palette.status.waiting,
		ViewTone::Error => palette.status.error,
	}
}

/// The glyph and color a status draws as. A running status is a static
/// glyph: a spinner inside the transcript would repaint the list every frame.
#[must_use]
pub const fn status_mark(status: ViewStatus, palette: &Palette) -> (&'static str, Hsla) {
	match status {
		ViewStatus::Success | ViewStatus::Done => ("✓", palette.status.success),
		ViewStatus::Error => ("✕", palette.status.error),
		ViewStatus::Warning => ("!", palette.status.waiting),
		ViewStatus::Info => ("i", palette.status.info),
		ViewStatus::Pending => ("○", palette.text.muted),
		ViewStatus::Running => ("●", palette.status.running),
		ViewStatus::Aborted => ("⊘", palette.text.muted),
	}
}

/// Draws `view`. `id` keys the stateful parts (scrolling panes, links).
pub fn render_view(view: &ToolView, id: &str, app: &Entity<AppState>, cx: &App) -> AnyElement {
	match view {
		ToolView::StatusRow(row) => status_row(row, id, app, cx).into_any_element(),
		ToolView::TextBlock(block) => spans(&block.spans, id, app, cx).into_any_element(),
		ToolView::HeadedBlock(block) => headed(block, id, app, cx),
		ToolView::FramedBlock(block) => framed(block, id, app, cx),
		ToolView::Notice(notice) => notice_view(notice, id, app, cx),
	}
}

fn status_row(row: &StatusRowView, id: &str, app: &Entity<AppState>, cx: &App) -> impl IntoElement {
	let palette = cx.theme().palette;
	let mark = row.status.map(|status| status_mark(status, &palette));
	let title_color = row.title_tone.map_or(palette.text.primary, |tone| tone_color(tone, &palette));
	let description = row.description.clone().map(|description| {
		let color = row.description_tone.map_or(palette.text.muted, |tone| tone_color(tone, &palette));
		let target = row.description_link.clone().or_else(|| row.description_file.clone());
		link_span(
			div().text_color(color).truncate().child(description),
			format!("{id}-desc"),
			target,
			app,
		)
	});
	div()
		.flex()
		.flex_col()
		.gap(space::S1)
		.child(
			div()
				.flex()
				.items_center()
				.gap(space::S2)
				.type_style(text::UI)
				.children(mark.map(|(glyph, color)| div().text_color(color).child(glyph)))
				.children(row.emblem.clone().map(|emblem| {
					let color =
						row.emblem_tone.map_or(palette.text.muted, |tone| tone_color(tone, &palette));
					div().text_color(color).child(emblem)
				}))
				.child(div().text_color(title_color).child(row.title.clone()))
				.children(description)
				.children(row.badge.as_ref().map(|badge| {
					div()
						.px(space::S1_5)
						.rounded(radius::SM)
						.bg(palette.bg.selected)
						.type_style(text::MICRO)
						.text_color(tone_color(badge.tone, &palette))
						.child(badge.label.clone())
				})),
		)
		.children(
			row.meta
				.iter()
				.enumerate()
				.map(|(ix, line)| view_line(line, &format!("{id}-meta{ix}"), app, cx)),
		)
}

fn headed(block: &HeadedBlockView, id: &str, app: &Entity<AppState>, cx: &App) -> AnyElement {
	div()
		.flex()
		.flex_col()
		.gap(space::S1)
		.children(block.header.as_ref().map(|row| status_row(row, id, app, cx)))
		.child(pane(block.lines.iter(), None, id, app, cx))
		.children(hidden(block.hidden.as_ref(), cx))
		.into_any_element()
}

fn framed(block: &FramedBlockView, id: &str, app: &Entity<AppState>, cx: &App) -> AnyElement {
	let palette = cx.theme().palette;
	let border = match block.state {
		Some(status) if status.is_error() => palette.status.error,
		_ => palette.border.subtle,
	};
	div()
		.flex()
		.flex_col()
		.gap(space::S1)
		.children(block.header.as_ref().map(|row| status_row(row, id, app, cx)))
		.child(
			div()
				.flex()
				.flex_col()
				.gap(space::S2)
				.p(space::S2)
				.rounded(radius::MD)
				.border_1()
				.border_color(border)
				.children(
					block
						.sections
						.iter()
						.enumerate()
						.map(|(ix, section)| view_section(section, &format!("{id}-s{ix}"), app, cx)),
				),
		)
		.into_any_element()
}

fn view_section(section: &ViewSection, id: &str, app: &Entity<AppState>, cx: &App) -> AnyElement {
	let palette = cx.theme().palette;
	div()
		.flex()
		.flex_col()
		.gap(space::S1)
		.when(section.separator, |d| d.border_t_1().border_color(palette.border.subtle).pt(space::S2))
		.children(section.label.clone().map(|label| {
			div().type_style(text::SMALL).text_color(palette.text.muted).child(label)
		}))
		.child(pane(section.lines.iter(), Some(section), id, app, cx))
		.children(hidden(section.hidden.as_ref(), cx))
		.into_any_element()
}

/// Lines drawn in the mono register, colored by the diff side or indented by
/// the tree depth the section states.
fn pane<'a>(
	lines: impl Iterator<Item = &'a ViewLine>,
	section: Option<&ViewSection>,
	id: &str,
	app: &Entity<AppState>,
	cx: &App,
) -> impl IntoElement {
	let palette = cx.theme().palette;
	let diff = section.and_then(|section| section.diff.as_ref());
	let tree = section.and_then(|section| section.tree.as_ref());
	let numbers = section
		.and_then(|section| section.code.as_ref())
		.and_then(|code| code.line_numbers.clone());
	let list = section.is_some_and(|section| section.list);
	let rows = lines.enumerate().map(|(ix, line)| {
		let side = diff.and_then(|diff| diff.sides.get(ix)).copied();
		let depth = tree.and_then(|tree| tree.depth.get(ix)).copied().unwrap_or(0);
		let number = numbers.as_ref().and_then(|numbers| numbers.get(ix).copied().flatten());
		let (bg, marker) = match side {
			Some(ViewDiffSide::Added) => (Some(palette.diff.add_bg), "+"),
			Some(ViewDiffSide::Removed) => (Some(palette.diff.del_bg), "-"),
			Some(ViewDiffSide::Gap) => (None, "⋯"),
			Some(ViewDiffSide::Context) | None => (None, if list { "•" } else { "" }),
		};
		div()
			.flex()
			.gap(space::S2)
			.when_some(bg, |d, bg| d.bg(bg))
			.children(number.map(|n| div().text_color(palette.text.faint).child(n.to_string())))
			.when(!marker.is_empty(), |d| d.child(div().text_color(palette.text.muted).child(marker)))
			.child(
				div()
					.pl(space::S3 * depth as f32)
					.child(view_line(line, &format!("{id}-l{ix}"), app, cx)),
			)
	});
	div()
		.id(SharedString::from(format!("{id}-pane")))
		.flex()
		.flex_col()
		.type_style(text::MONO)
		.text_color(palette.text.secondary)
		.children(rows)
}

fn hidden(hidden: Option<&ViewHiddenCount>, cx: &App) -> Option<impl IntoElement> {
	let hidden = hidden.filter(|hidden| hidden.count > 0)?;
	Some(
		div()
			.type_style(text::SMALL)
			.text_color(cx.theme().palette.text.muted)
			.child(format!("… {}", hidden.format_label())),
	)
}

fn notice_view(notice: &NoticeView, id: &str, app: &Entity<AppState>, cx: &App) -> AnyElement {
	let palette = cx.theme().palette;
	let (glyph, color) = status_mark(notice.state, &palette);
	div()
		.flex()
		.flex_col()
		.gap(space::S1)
		.child(
			div()
				.flex()
				.items_center()
				.gap(space::S2)
				.child(div().text_color(color).child(notice.mark.clone().unwrap_or_else(|| glyph.to_owned())))
				.child(view_line(&notice.headline, &format!("{id}-head"), app, cx))
				.children(notice.tag.clone().map(|tag| div().text_color(palette.text.muted).child(tag))),
		)
		.children(
			notice
				.body
				.iter()
				.enumerate()
				.map(|(ix, line)| view_line(line, &format!("{id}-b{ix}"), app, cx)),
		)
		.into_any_element()
}

/// One line of spans.
pub fn view_line(line: &ViewLine, id: &str, app: &Entity<AppState>, cx: &App) -> AnyElement {
	spans(line, id, app, cx).into_any_element()
}

fn spans(spans: &[ViewSpan], id: &str, app: &Entity<AppState>, cx: &App) -> impl IntoElement {
	let palette = cx.theme().palette;
	div().flex().flex_wrap().children(spans.iter().enumerate().map(|(ix, span)| {
		let words = if span.captured { sanitize(&span.text) } else { span.text.clone() };
		let words = match &span.symbol {
			Some(symbol) => format!("{symbol} {words}"),
			None => words,
		};
		let color = span
			.status
			.map(|status| status_mark(status, &palette).1)
			.or_else(|| span.tone.map(|tone| tone_color(tone, &palette)))
			.unwrap_or(palette.text.primary);
		let element = div()
			.text_color(color)
			.whitespace_nowrap()
			.when(span.bold, |d| d.font_weight(gpui::FontWeight::SEMIBOLD))
			.when(span.italic, |d| d.italic())
			.when(span.strike, |d| d.line_through())
			.child(words);
		let target = span.link.clone().or_else(|| span.file.clone());
		link_span(element, format!("{id}-{ix}"), target, app)
	}))
}

/// `element`, opening `target` through the host when clicked.
fn link_span(
	element: gpui::Div,
	id: String,
	target: Option<String>,
	app: &Entity<AppState>,
) -> AnyElement {
	match target {
		Some(path) => {
			let app = app.clone();
			element
				.id(SharedString::from(id))
				.cursor_pointer()
				.underline()
				.on_click(move |_, _, cx| open_external(&app, path.clone(), cx))
				.into_any_element()
		},
		None => element.into_any_element(),
	}
}

/// Opens `path` (a URL or a file) in the operator's own application.
pub fn open_external(app: &Entity<AppState>, path: String, cx: &mut App) {
	app.update(cx, |app, cx| {
		app.dispatch(HostAction::OpenExternal { path }, SurfaceId::GlobalTitlebarLine, cx);
	});
}
