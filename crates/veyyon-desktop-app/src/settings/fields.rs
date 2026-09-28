//! The single-line inputs the settings pages type into, built the first time
//! a page draws them and kept by what they edit.

use veyyon_desktop_ui::{
	editor::{Editor, EditorEvent, EditorMode},
	theme::text,
};
use veyyon_gpui::{AppContext as _, Context, Entity, Subscription, Window};

use super::SettingsView;

/// What Enter in an input calls, or each edit of a live one: the view, the
/// input's key and its text.
pub type Submit = fn(&mut SettingsView, &str, String, &mut Window, &mut Context<SettingsView>);

/// How an input draws its text and when it reports it.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
	/// Drawn as typed, reported on Enter.
	Plain,
	/// Drawn masked, reported on Enter.
	Secret,
	/// Drawn as typed, reported on every edit.
	Live,
}

/// A single-line input and the subscription that routes its events.
pub struct Field {
	pub input:     Entity<Editor>,
	_subscription: Subscription,
}

impl SettingsView {
	/// The input editing `key`, built on first use. Enter in it calls
	/// `submit` with the text.
	pub(super) fn field(
		&mut self,
		key: &str,
		initial: &str,
		placeholder: &str,
		submit: Submit,
		window: &mut Window,
		cx: &mut Context<Self>,
	) -> Entity<Editor> {
		self.input(key, initial, placeholder, Kind::Plain, submit, window, cx)
	}

	/// The input editing the secret under `key`, drawn masked, built on first
	/// use. Enter in it calls `submit` with the text.
	pub(super) fn secret_field(
		&mut self,
		key: &str,
		placeholder: &str,
		submit: Submit,
		window: &mut Window,
		cx: &mut Context<Self>,
	) -> Entity<Editor> {
		self.input(key, "", placeholder, Kind::Secret, submit, window, cx)
	}

	/// The input under `key`, built on first use. Each edit calls `changed`
	/// with the text.
	pub(super) fn live_field(
		&mut self,
		key: &str,
		placeholder: &str,
		changed: Submit,
		window: &mut Window,
		cx: &mut Context<Self>,
	) -> Entity<Editor> {
		self.input(key, "", placeholder, Kind::Live, changed, window, cx)
	}

	fn input(
		&mut self,
		key: &str,
		initial: &str,
		placeholder: &str,
		kind: Kind,
		submit: Submit,
		window: &mut Window,
		cx: &mut Context<Self>,
	) -> Entity<Editor> {
		if let Some(field) = self.fields.get(key) {
			return field.input.clone();
		}
		let input = cx.new(|cx| {
			let mut editor = Editor::new(EditorMode::SingleLine, window, cx);
			editor.set_text_style(text::UI, cx);
			editor.set_placeholder(placeholder.to_owned(), cx);
			editor.set_masked(kind == Kind::Secret, cx);
			editor.set_text(initial, cx);
			editor
		});
		let owned = key.to_owned();
		let reported = if kind == Kind::Live {
			EditorEvent::Changed
		} else {
			EditorEvent::Submit
		};
		// Escape leaves the input for the page, dropping a keybinding edit,
		// so a second Escape closes settings.
		let subscription =
			cx.subscribe_in(&input, window, move |this, input, event: &EditorEvent, window, cx| {
				if *event == reported {
					let text = input.read(cx).text().to_owned();
					submit(this, &owned, text, window, cx);
				} else if *event == EditorEvent::Escape {
					this.editing = None;
					window.focus(&this.focus, cx);
					cx.notify();
				}
			});
		self.fields.insert(key.to_owned(), Field {
			input:         input.clone(),
			_subscription: subscription,
		});
		input
	}

	/// Replaces the text of the input editing `key`, when it exists.
	pub(super) fn set_field(&self, key: &str, value: &str, cx: &mut Context<Self>) {
		if let Some(field) = self.fields.get(key) {
			field
				.input
				.update(cx, |input, cx| input.set_text(value, cx));
		}
	}

	/// The trimmed text of the input editing `key`, or empty before it is
	/// drawn.
	pub(super) fn field_text(&self, key: &str, cx: &Context<Self>) -> String {
		self
			.fields
			.get(key)
			.map(|field| field.input.read(cx).text().trim().to_owned())
			.unwrap_or_default()
	}
}
