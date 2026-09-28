//! Where recognised speech lands in the draft.
//!
//! The host recognises speech and states everything the dictation has
//! committed, never the draft it goes in. The composer keeps the draft the
//! dictation started on and rewrites the editor from it on every revision, so
//! a segment the recogniser revises replaces what it revised instead of being
//! appended twice. The phrase still being said is shown after the committed
//! words until it is committed or dropped. A spoken submit phrase sends the
//! draft once.

use gpui::{AnyElement, Context, IntoElement, div, prelude::*};
use veyyon_desktop_model::{DictationView, HostAction, SurfaceId};
use veyyon_desktop_ui::{
	controls::{Button, ButtonSize, ButtonVariant, Spinner},
	theme::{ActiveTheme, TypeStyled, radius, size, space, text},
};

use super::Composer;

/// The draft a dictation started on and the revision it last landed.
#[derive(Default)]
pub(super) struct Landing {
	/// The draft before the dictation; `None` while no dictation lands.
	base:     Option<String>,
	/// The revision of the view last landed.
	revision: Option<u64>,
}

/// `base` followed by the dictated `words`, one space between them.
fn joined(base: &str, words: &[&str]) -> String {
	let mut text = base.to_owned();
	for word in words
		.iter()
		.map(|word| word.trim())
		.filter(|word| !word.is_empty())
	{
		if !text.is_empty() && !text.ends_with(char::is_whitespace) {
			text.push(' ');
		}
		text.push_str(word);
	}
	text
}

impl Composer {
	/// The host stated a new dictation view: lands its words in the draft and
	/// sends the draft when the submit phrase fired.
	pub(super) fn dictation_changed(&mut self, cx: &mut Context<Self>) {
		let Some(view) = self.app.read(cx).store().domains.dictation.clone() else {
			self.landing = Landing::default();
			cx.notify();
			return;
		};
		if self.landing.revision == Some(view.revision) {
			return;
		}
		self.landing.revision = Some(view.revision);
		let active = view.state.is_active();
		if active || self.landing.base.is_some() {
			let draft = self.text(cx).to_owned();
			let base = self.landing.base.get_or_insert(draft).clone();
			let partial = if active { view.partial.as_str() } else { "" };
			let text = joined(&base, &[&view.utterance, partial]);
			if text != self.text(cx) {
				self.set_text(&text, cx);
			}
		}
		if !active {
			self.landing.base = None;
		}
		if view.submit {
			self.submit(cx);
		}
		cx.notify();
	}

	/// Opens the microphone, or closes it and keeps what was said.
	pub(super) fn toggle_dictation(&self, cx: &mut Context<Self>) {
		self.send_dictation(HostAction::ToggleDictation, cx);
	}

	/// Closes the microphone and drops what it heard.
	pub(super) fn cancel_dictation(&self, cx: &mut Context<Self>) {
		self.send_dictation(HostAction::CancelDictation, cx);
	}

	fn send_dictation(&self, action: HostAction, cx: &mut Context<Self>) {
		let Some(session) = self.session.clone() else {
			return;
		};
		self.app.update(cx, |app, cx| {
			app.dispatch(action, SurfaceId::ComposerDictateButton(session), cx);
		});
	}

	/// The dictation view, while a dictation runs or reports an error.
	pub(super) fn dictation(&self, cx: &gpui::App) -> Option<DictationView> {
		let view = self.app.read(cx).store().domains.dictation.as_ref()?;
		(view.state.is_active() || view.error.is_some()).then(|| view.clone())
	}

	/// The strip stating where the dictation is and what it heard.
	pub(super) fn render_dictation(&self, cx: &Context<Self>) -> Option<AnyElement> {
		let view = self.dictation(cx)?;
		let palette = cx.theme().palette;
		let detail = view
			.error
			.clone()
			.or_else(|| view.status.clone())
			.or_else(|| (!view.partial.is_empty()).then(|| view.partial.clone()));
		let ink = if view.error.is_some() {
			palette.status.error
		} else {
			palette.text.muted
		};
		Some(
			div()
				.id("composer-dictation")
				.flex()
				.items_center()
				.gap(space::S2)
				.px(space::S3)
				.py(space::S1_5)
				.rounded(radius::LG)
				.bg(palette.bg.surface)
				.border_1()
				.border_color(palette.border.subtle)
				.type_style(text::SMALL)
				.when(view.state.is_active(), |row| {
					row.child(Spinner::new("composer-dictation-spinner").size(size::ICON_SM))
				})
				.child(
					div()
						.text_color(palette.text.secondary)
						.child(view.state.label()),
				)
				.children(detail.map(|detail| {
					div()
						.flex_1()
						.min_w_0()
						.truncate()
						.text_color(ink)
						.child(detail)
				}))
				.when(view.state.is_active(), |row| {
					row.child(
						Button::new("composer-dictation-cancel", "Cancel")
							.variant(ButtonVariant::Ghost)
							.size(ButtonSize::Sm)
							.on_click(cx.listener(|this, _, _, cx| this.cancel_dictation(cx))),
					)
				})
				.into_any_element(),
		)
	}
}
