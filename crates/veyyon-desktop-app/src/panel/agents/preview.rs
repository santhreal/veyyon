//! A read-only transcript of one agent's session under the roster, which
//! never changes the session the window has open.

use veyyon_desktop_model::{MessageRole, SessionId, TranscriptEntry};
use veyyon_desktop_ui::{
	controls::{Button, ButtonSize, ButtonVariant, IconButton, Spinner},
	icons::IconName,
	theme::{ActiveTheme, Palette, TypeStyled, space, text},
};
use veyyon_gpui::{
	AnyElement, ClickEvent, Context, Div, IntoElement, ParentElement, Styled, Window, div, list,
	prelude::*,
};

use super::{AgentsView, row_name};
use crate::{panel::style::toolbar, transcript::plan::copy_text};

/// The most lines one entry shows in the preview before it is cut.
pub const PREVIEW_LINES: usize = 6;

/// What the preview calls the author of an entry.
pub const fn role_label(role: MessageRole) -> &'static str {
	match role {
		MessageRole::User => "User",
		MessageRole::Developer => "Developer",
		MessageRole::Assistant => "Assistant",
		MessageRole::ToolResult => "Tool",
		MessageRole::BashExecution => "Shell",
		MessageRole::PythonExecution => "Python",
		MessageRole::Custom => "Extension",
		MessageRole::BranchSummary => "Branch summary",
		MessageRole::CompactionSummary => "Compaction",
		MessageRole::FileMention => "File",
		MessageRole::Lifecycle => "Session",
		MessageRole::Unknown => "Entry",
	}
}

/// The first [`PREVIEW_LINES`] lines of an entry's words, and whether more
/// were cut.
pub fn excerpt(entry: &TranscriptEntry) -> (String, bool) {
	let words = copy_text(entry);
	let mut lines = words.lines();
	let shown = lines
		.by_ref()
		.take(PREVIEW_LINES)
		.collect::<Vec<_>>()
		.join("\n");
	(shown, lines.next().is_some())
}

impl AgentsView {
	/// The entries of the preview the host answered for the session the tab
	/// previews, or `None` while it has not answered.
	pub(super) fn preview_entries<'a>(
		&self,
		cx: &'a Context<Self>,
	) -> Option<&'a [TranscriptEntry]> {
		let previewing = self.previewing.as_ref()?;
		let preview = self.app.read(cx).store().domains.session_preview.as_ref()?;
		(preview.session == *previewing).then_some(preview.transcript.value.as_slice())
	}

	/// Brings the preview list to the entries the host answered.
	pub(super) fn sync_preview(&self, cx: &Context<Self>) {
		let count = self.preview_entries(cx).map_or(0, <[_]>::len);
		self.preview_list.reset(count);
	}

	pub(super) fn render_preview(
		&self,
		session: &SessionId,
		palette: &Palette,
		cx: &Context<Self>,
	) -> AnyElement {
		let app = self.app.read(cx);
		let title = app
			.session_title(session)
			.or_else(|| {
				app.store()
					.domains
					.agents
					.iter()
					.find(|agent| agent.session.as_ref() == Some(session))
					.map(row_name)
			})
			.map_or_else(|| session.0.clone(), str::to_owned);
		let open = session.clone();
		let header = toolbar(palette)
			.child(
				div()
					.flex_1()
					.min_w_0()
					.truncate()
					.type_style(text::UI_MEDIUM)
					.text_color(palette.text.primary)
					.child(title),
			)
			.child(
				Button::new("agent-preview-open", "Open")
					.size(ButtonSize::Sm)
					.variant(ButtonVariant::Ghost)
					.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
						let session = open.clone();
						this.app.update(cx, |app, cx| {
							app.open_session(session, cx);
						});
					})),
			)
			.child(
				IconButton::new("agent-preview-close", IconName::X)
					.tooltip("Close the preview")
					.on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.close_preview(cx))),
			);
		let body = match self.preview_entries(cx) {
			None => div()
				.flex()
				.flex_1()
				.items_center()
				.justify_center()
				.child(Spinner::new("agent-preview-loading"))
				.into_any_element(),
			Some([]) => div()
				.flex()
				.flex_1()
				.items_center()
				.justify_center()
				.type_style(text::UI)
				.text_color(palette.text.muted)
				.child("The session holds no entry")
				.into_any_element(),
			Some(_) => list(
				self.preview_list.clone(),
				cx.processor(|this, ix: usize, _: &mut Window, cx| {
					let palette = cx.theme().palette;
					this
						.preview_entries(cx)
						.and_then(|entries| entries.get(ix))
						.map_or_else(
							|| div().into_any_element(),
							|entry| preview_row(entry, &palette).into_any_element(),
						)
				}),
			)
			.flex_1()
			.min_h_0()
			.into_any_element(),
		};
		div()
			.id("agents-preview")
			.flex()
			.flex_col()
			.flex_1()
			.min_h_0()
			.border_t_1()
			.border_color(palette.border.subtle)
			.bg(palette.bg.surface)
			.child(header)
			.child(body)
			.into_any_element()
	}
}

/// One entry: who wrote it over the first lines of what it says.
fn preview_row(entry: &TranscriptEntry, palette: &Palette) -> Div {
	let (words, cut) = excerpt(entry);
	div()
		.flex()
		.flex_col()
		.gap(space::S0_5)
		.px(space::S3)
		.py(space::S1_5)
		.child(
			div()
				.type_style(text::SMALL)
				.text_color(palette.text.muted)
				.child(role_label(entry.role)),
		)
		.when(!words.is_empty(), |el| {
			el.child(
				div()
					.type_style(text::UI)
					.text_color(palette.text.secondary)
					.child(words),
			)
		})
		.when(cut, |el| {
			el.child(
				div()
					.type_style(text::SMALL)
					.text_color(palette.text.faint)
					.child("\u{2026}"),
			)
		})
}
