//! The row an item shows on hover: Copy and Branch from here, and Retry and
//! Rephrase under the last reply of a finished turn.

use gpui::{AnyElement, ClipboardItem, SharedString, div, prelude::*};
use veyyon_desktop_model::{EntryId, HostAction, SessionId, SurfaceId};
use veyyon_desktop_ui::{
	controls::IconButton,
	icons::IconName,
	theme::{Palette, space},
};

use super::{
	Transcript,
	plan::{Plan, copy_text},
};

impl Transcript {
	pub(super) fn item_actions(
		&self,
		ix: usize,
		plan: &Plan,
		session: &SessionId,
		last: bool,
		palette: &Palette,
	) -> AnyElement {
		let copy = {
			let app = self.app.clone();
			let session = session.clone();
			IconButton::new(SharedString::from(format!("t{ix}-copy")), IconName::Copy)
				.tooltip("Copy")
				.on_click(move |_, _, cx| {
					let words = app
						.read(cx)
						.entry_at(&session, ix)
						.map(copy_text)
						.unwrap_or_default();
					cx.write_to_clipboard(ClipboardItem::new_string(words));
				})
		};
		let branch = self.session_button(
			format!("t{ix}-branch"),
			IconName::GitFork,
			"Branch from here",
			session,
			Some(plan.id.clone()),
			Action::Branch,
		);
		let turn_actions = last.then(|| {
			[
				self.session_button(
					format!("t{ix}-retry"),
					IconName::RefreshCw,
					"Retry",
					session,
					None,
					Action::Retry,
				),
				self.session_button(
					format!("t{ix}-rephrase"),
					IconName::Pencil,
					"Rephrase",
					session,
					None,
					Action::Rephrase,
				),
			]
		});
		div()
			.flex()
			.gap(space::S1)
			.text_color(palette.text.muted)
			.when(plan.operator, |d| d.justify_end())
			.child(copy)
			.child(branch)
			.children(turn_actions.into_iter().flatten())
			.into_any_element()
	}

	fn session_button(
		&self,
		id: String,
		icon: IconName,
		label: &'static str,
		session: &SessionId,
		entry: Option<EntryId>,
		action: Action,
	) -> IconButton {
		let app = self.app.clone();
		let session = session.clone();
		IconButton::new(SharedString::from(id), icon)
			.tooltip(label)
			.on_click(move |_, _, cx| {
				let (session, entry) = (session.clone(), entry.clone());
				app.update(cx, |app, cx| {
					let (host, surface) = match action {
						Action::Branch => (
							HostAction::BranchSession { session: session.clone(), entry },
							SurfaceId::SessionBranchButton(session),
						),
						Action::Retry => (
							HostAction::RetryTurn { session: session.clone() },
							SurfaceId::SessionRetryButton(session),
						),
						Action::Rephrase => (
							HostAction::RephraseReply { session: session.clone() },
							SurfaceId::SessionRephraseButton(session),
						),
					};
					app.dispatch(host, surface, cx);
				});
			})
	}
}

/// The session-level actions an item's hover row sends.
#[derive(Clone, Copy)]
enum Action {
	Branch,
	Retry,
	Rephrase,
}
