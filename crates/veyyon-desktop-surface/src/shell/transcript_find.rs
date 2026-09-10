//! In-transcript find floating toolbar and `ShellView` lifecycle (§5.2, §5.3,
//! §5.14).

use std::time::Instant;

use veyyon_desktop_kit::{
	controls::{IconButton, IconButtonVariant},
	icons::{Icon, IconName, IconSize},
	input::{Editor, EditorEvent, EditorMode},
	token_set::{ColorRole, RadiusStep, SpacingStep, TextRamp, TokenSet},
};
use veyyon_gpui::{
	Context, Entity, InteractiveElement, IntoElement, ParentElement, Styled, Window, div, prelude::*,
};

use super::ShellView;

impl ShellView {
	/// Returns the existing find editor or creates a new single-line editor
	/// subscribed to input, submission, and dismissal events.
	pub fn ensure_find_editor(&mut self, cx: &mut Context<Self>) -> Entity<Editor> {
		if let Some(editor) = &self.find_state.editor {
			return editor.clone();
		}
		let editor =
			cx.new(|cx| Editor::new(EditorMode::SingleLine, cx).placeholder("Find in transcript..."));
		let subscription = cx.subscribe(&editor, |view, editor, event, cx| {
			match event {
				EditorEvent::Changed => {
					let query = editor.read(cx).text().to_owned();
					let reduced = view.rail_motion.is_reduced_motion();
					view.find_state.set_query_and_reveal(
						&query,
						&view.state.transcript,
						&view.transcript_viewport,
						&view.installed.motion,
						reduced,
						Instant::now(),
					);
				},
				EditorEvent::Submit => {
					view.transcript_find_next();
				},
				EditorEvent::Escape => {
					view.dismiss_transcript_find(cx);
				},
				EditorEvent::PasteMedia(_) => {},
			}
			cx.notify();
		});
		self.subscriptions.push(subscription);
		self.find_state.editor = Some(editor.clone());
		editor
	}

	/// Opens the transcript find bar, creates/focuses the find editor, and
	/// triggers repaint.
	pub fn open_transcript_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		self.state.keymap.find_open = true;
		let editor = self.ensure_find_editor(cx);
		let focus = editor.read(cx).focus_handle().clone();
		window.focus(&focus, cx);
		cx.notify();
	}

	/// Closes the transcript find bar, clears query and editor text, and
	/// restores focus to composer.
	pub fn close_transcript_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		self.state.keymap.find_open = false;
		self.find_state.clear();
		if let Some(editor) = &self.find_state.editor {
			editor.update(cx, |ed, cx| {
				ed.set_text("", cx);
			});
		}
		if let Some(composer) = &self.composer {
			let focus = composer.read(cx).focus_handle().clone();
			window.focus(&focus, cx);
		}
		cx.notify();
	}

	/// Dismisses the transcript find bar and clears state without explicit
	/// window focus restoration.
	pub fn dismiss_transcript_find(&mut self, cx: &mut Context<Self>) {
		self.state.keymap.find_open = false;
		self.find_state.clear();
		self.palette_input.restore_focus = true;
		if let Some(editor) = &self.find_state.editor {
			editor.update(cx, |ed, cx| {
				ed.set_text("", cx);
			});
		}
		cx.notify();
	}

	/// Advances to the next matching hit in the transcript.
	pub fn transcript_find_next(&mut self) {
		let reduced = self.rail_motion.is_reduced_motion();
		self.find_state.next_match(
			&self.transcript_viewport,
			&self.installed.motion,
			reduced,
			Instant::now(),
		);
	}

	/// Jumps to the previous matching hit in the transcript.
	pub fn transcript_find_prev(&mut self) {
		let reduced = self.rail_motion.is_reduced_motion();
		self.find_state.prev_match(
			&self.transcript_viewport,
			&self.installed.motion,
			reduced,
			Instant::now(),
		);
	}

	/// Renders the floating transcript find toolbar using kit primitives and
	/// token-driven styles.
	pub fn render_transcript_find_bar(
		&mut self,
		tokens: &TokenSet,
		cx: &mut Context<Self>,
	) -> impl IntoElement + use<> {
		let editor = self.ensure_find_editor(cx);
		let match_count = self.find_state.match_count();
		let cur_match = self.find_state.current_match_number();
		let has_query = self.find_state.has_query();

		let match_text = if !has_query {
			String::new()
		} else if match_count == 0 {
			"No matching blocks".to_string()
		} else {
			format!("{cur_match} of {match_count} blocks")
		};

		let weak_next = cx.weak_entity();
		let weak_prev = cx.weak_entity();
		let weak_close = cx.weak_entity();

		let s2 = tokens.spacing(SpacingStep::S2);
		let s4 = tokens.spacing(SpacingStep::S4);
		let r_med = tokens.radius(RadiusStep::Md);

		div()
			.id("transcript-find-bar")
			.flex()
			.flex_row()
			.items_center()
			.gap(s2)
			.px(s2)
			.py(s2 * 0.5)
			.bg(tokens.color(ColorRole::Float))
			.border_1()
			.border_color(tokens.color(ColorRole::Hairline))
			.rounded(r_med)
			.child(
				Icon::new(IconName::Search)
					.size(IconSize::Size14)
					.color(tokens.color(ColorRole::Muted)),
			)
			.child(div().w(s4 * 10.0).child(editor))
			.when(!match_text.is_empty(), |el| {
				el.child(
					div()
						.text_size(tokens.font_size(TextRamp::Micro))
						.text_color(tokens.color(ColorRole::Muted))
						.child(match_text),
				)
			})
			.child(
				IconButton::new("find-previous", IconName::ChevronUp)
					.size(IconSize::Size14)
					.variant(IconButtonVariant::Ghost)
					.on_click(move |_, _, cx| {
						if let Some(view) = weak_prev.upgrade() {
							view.update(cx, |this, cx| {
								this.transcript_find_prev();
								cx.notify();
							});
						}
					}),
			)
			.child(
				IconButton::new("find-next", IconName::ChevronDown)
					.size(IconSize::Size14)
					.variant(IconButtonVariant::Ghost)
					.on_click(move |_, _, cx| {
						if let Some(view) = weak_next.upgrade() {
							view.update(cx, |this, cx| {
								this.transcript_find_next();
								cx.notify();
							});
						}
					}),
			)
			.child(
				IconButton::new("find-close", IconName::Close)
					.size(IconSize::Size14)
					.variant(IconButtonVariant::Ghost)
					.on_click(move |_, window, cx| {
						if let Some(view) = weak_close.upgrade() {
							view.update(cx, |this, cx| {
								this.close_transcript_find(window, cx);
							});
						}
					}),
			)
	}
}
