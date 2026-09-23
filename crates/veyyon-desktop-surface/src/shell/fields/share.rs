//! What a submit of the share card's link field sends.

use veyyon_desktop_kit::input::Editor;
use veyyon_desktop_model::SharePhase;
use veyyon_gpui::{Context, Entity};

use crate::{Intent, Overlay, ShellView};

/// Sends the join action for the link the field holds, and empties it on
/// submit.
///
/// An empty link is refused immediately to avoid an unnecessary round trip.
pub(super) fn commit_join(
	view: &mut ShellView,
	editor: &Entity<Editor>,
	cx: &mut Context<ShellView>,
) {
	let link = editor.read(cx).text().trim().to_owned();
	if link.is_empty() {
		view.refuse_field(cx, "A link is required to join a share");
		return;
	}
	editor.update(cx, |editor, cx| editor.set_text(String::new(), cx));
	view.clear_refusal();
	view.dispatch(Intent::JoinShare { session: None, link }, cx);
}

impl ShellView {
	/// Whether the share link field is currently drawn on screen.
	#[must_use]
	pub fn share_link_is_drawn(&self) -> bool {
		self
			.state()
			.overlay
			.as_ref()
			.and_then(Overlay::as_share)
			.is_some_and(|share| share.phase() == SharePhase::Off)
	}
}
