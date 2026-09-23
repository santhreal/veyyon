//! What a submit of the Profiles page's name field sends.
//!
//! The field holds a name and nothing else; what a create copies is the set
//! of switches on the page, which is read here rather than carried by the
//! field, so the two cannot disagree by a frame.

use veyyon_desktop_kit::input::Editor;
use veyyon_gpui::{Context, Entity};

use crate::{Intent, ShellView, settings::SettingsState};

/// Sends the create the name field holds, and empties it on the way out so
/// the page is ready for the next name rather than holding the last one.
///
/// A name of nothing is refused where it was typed: the host answers one with
/// `INVALID_ARGUMENTS`, so sending it spends a round trip to learn what the
/// field already states.
pub(super) fn commit_create(
	view: &mut ShellView,
	editor: &Entity<Editor>,
	cx: &mut Context<ShellView>,
) {
	let name = editor.read(cx).text().trim().to_owned();
	if name.is_empty() {
		view.refuse_field(cx, "A new profile needs a name");
		return;
	}
	let copy = view
		.active_settings()
		.map(SettingsState::profile_copy_keys)
		.unwrap_or_default();
	editor.update(cx, |editor, cx| editor.set_text(String::new(), cx));
	view.clear_refusal();
	view.dispatch(Intent::CreateProfile { name, copy }, cx);
}

/// Sends what the name field holds as the new display name of `name`, and
/// empties the field. A rename of nothing is refused where it was typed,
/// for the same reason a create of nothing is.
pub(super) fn commit_rename(
	view: &mut ShellView,
	editor: &Entity<Editor>,
	name: &str,
	cx: &mut Context<ShellView>,
) {
	let display_name = editor.read(cx).text().trim().to_owned();
	if display_name.is_empty() {
		view.refuse_field(cx, "A rename needs the new name in the field above");
		return;
	}
	editor.update(cx, |editor, cx| editor.set_text(String::new(), cx));
	view.clear_refusal();
	view.dispatch(Intent::RenameProfile { name: name.to_owned(), display_name }, cx);
}
