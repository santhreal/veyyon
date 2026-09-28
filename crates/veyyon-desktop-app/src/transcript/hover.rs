//! The row an item shows on hover: Copy, Branch from here under a prompt,
//! and Retry and Rephrase under the last reply of a finished turn.

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
use crate::driver;

impl Transcript {
	pub(super) fn item_actions(
		&self,
		ix: usize,
		plan: &Plan,
		session: &SessionId,
		offers_turn_actions: bool,
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
		// The host forks only at a prompt.
		let branch = plan
			.prompt
			.then(|| self.session_button(ix, &plan.id, session, Action::Branch));
		let turn_actions = offers_turn_actions.then(|| {
			[Action::Retry, Action::Rephrase]
				.map(|action| self.session_button(ix, &plan.id, session, action))
		});
		div()
			.flex()
			.gap(space::S1)
			.text_color(palette.text.muted)
			.when(plan.operator, |d| d.justify_end())
			.child(copy)
			.children(branch)
			.children(turn_actions.into_iter().flatten())
			.into_any_element()
	}

	/// The button that sends `action` for item `ix`, the entry `id`, of
	/// `session`, registered with the driver as `transcript.<verb>:<id>`.
	fn session_button(
		&self,
		ix: usize,
		id: &EntryId,
		session: &SessionId,
		action: Action,
	) -> AnyElement {
		let (target, verb, icon, label) = match action {
			Action::Branch => ("transcript.branch", "branch", IconName::GitFork, "Branch from here"),
			Action::Retry => ("transcript.retry", "retry", IconName::RefreshCw, "Retry"),
			Action::Rephrase => ("transcript.rephrase", "rephrase", IconName::Pencil, "Rephrase"),
		};
		let app = self.app.clone();
		let session = session.clone();
		let entry = matches!(action, Action::Branch).then(|| id.clone());
		let button = IconButton::new(SharedString::from(format!("t{ix}-{verb}")), icon)
			.tooltip(label)
			.on_click(move |_, _, cx| {
				let session = session.clone();
				let (host, surface) = match action {
					Action::Branch => (
						HostAction::BranchSession { session: session.clone(), entry: entry.clone() },
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
				app.update(cx, |app, cx| {
					app.dispatch(host, surface, cx);
				});
			});
		driver::target((target, id.0.as_str()), button)
	}
}

/// The session-level actions an item's hover row sends.
#[derive(Clone, Copy)]
enum Action {
	Branch,
	Retry,
	Rephrase,
}
