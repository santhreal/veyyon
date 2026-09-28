//! A tool call's row: status glyph, verb, target, duration and Cancel, with
//! the call's output under it while the row is open.

use gpui::{AnyElement, Context, Hsla, SharedString, div, prelude::*};
use veyyon_desktop_model::{HostAction, SessionId, SurfaceId, tool_view::ViewStatus};
use veyyon_desktop_ui::{
	controls::IconButton,
	icons::IconName,
	theme::{Palette, TypeStyled, radius, size, space, text},
};

use super::{
	Transcript,
	plan::{ToolBody, ToolRow},
	tool::{render_view, status_mark},
	turn::duration_words,
};

impl Transcript {
	pub(super) fn tool_row(
		&self,
		ix: usize,
		row: &ToolRow,
		id: &str,
		session: &SessionId,
		palette: &Palette,
		cx: &Context<Self>,
	) -> AnyElement {
		let (glyph, color) = status_mark(row.status, palette);
		let this = Self::weak(cx);
		let (call_id, open) = (row.call_id.clone(), !row.open);
		let cancel = (row.status == ViewStatus::Running).then(|| {
			let app = self.app.clone();
			let (session, tool_call_id) = (session.clone(), row.call_id.clone());
			IconButton::new(SharedString::from(format!("{id}-cancel")), IconName::Square)
				.tooltip("Cancel")
				.on_click(move |_, _, cx| {
					let (session, tool_call_id) = (session.clone(), tool_call_id.clone());
					app.update(cx, |app, cx| {
						let surface =
							SurfaceId::ComposerCancelToolButton(session.clone(), tool_call_id.clone());
						app.dispatch(HostAction::CancelTool { session, tool_call_id }, surface, cx);
					});
				})
		});
		let header = div()
			.id(SharedString::from(id.to_owned()))
			.flex()
			.items_center()
			.gap(space::S2)
			.type_style(text::UI)
			.cursor_pointer()
			.child(div().text_color(color).child(glyph))
			.child(
				div()
					.text_color(palette.text.primary)
					.child(row.verb.clone()),
			)
			.children(row.target.clone().map(|target| {
				div()
					.flex_1()
					.min_w_0()
					.truncate()
					.text_color(palette.text.muted)
					.child(target)
			}))
			.children(row.duration_ms.map(|ms| {
				div()
					.type_style(text::SMALL)
					.text_color(palette.text.faint)
					.child(duration_words(ms / 1000))
			}))
			.children(cancel)
			.on_click(move |_, _, cx| {
				this
					.update(cx, |this, cx| this.toggle_tool(ix, call_id.clone(), open, cx))
					.ok();
			});
		let body = row.body.as_ref().map(|body| match body {
			ToolBody::View(presentation) => div()
				.pl(space::S5)
				.child(render_view(&presentation.view, id, &self.app, cx))
				.into_any_element(),
			ToolBody::Lines(lines) => div()
				.pl(space::S5)
				.child(output_pane(id, lines, false, palette))
				.into_any_element(),
		});
		div()
			.flex()
			.flex_col()
			.gap(space::S1)
			.child(header)
			.children(body)
			.into_any_element()
	}
}

/// Output lines in a mono pane at most `TOOL_OUTPUT_MAX` tall, scrolling
/// past that. A diff colors each line by its first character.
pub(super) fn output_pane(id: &str, lines: &[String], diff: bool, palette: &Palette) -> AnyElement {
	div()
		.id(SharedString::from(format!("{id}-out")))
		.max_h(size::TOOL_OUTPUT_MAX)
		.overflow_y_scroll()
		.p(space::S2)
		.rounded(radius::MD)
		.bg(palette.code.bg)
		.type_style(text::MONO)
		.text_color(palette.text.secondary)
		.children(lines.iter().map(|line| {
			let color: Option<Hsla> = if diff {
				match line.chars().next() {
					Some('+') => Some(palette.diff.add_fg),
					Some('-') => Some(palette.diff.del_fg),
					_ => None,
				}
			} else {
				None
			};
			div()
				.whitespace_nowrap()
				.when_some(color, |d, color| d.text_color(color))
				.child(line.clone())
		}))
		.into_any_element()
}
