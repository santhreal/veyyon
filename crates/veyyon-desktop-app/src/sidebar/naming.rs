//! Inline naming: renaming a thread in its row, and naming a new or the
//! active profile above the footer. Enter or leaving the field commits a
//! non-empty name; Escape cancels.

use gpui::{AppContext as _, Context, Entity, Focusable, Subscription, Window};
use veyyon_desktop_model::{HostAction, SessionId, SurfaceId};
use veyyon_desktop_ui::editor::{Editor, EditorEvent, EditorMode};

use super::Sidebar;

/// What a name is being typed for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum NameTarget {
	/// The title of a thread.
	Session(SessionId),
	/// A profile to create.
	NewProfile,
	/// The display name of the profile with this directory name.
	Profile(String),
}

/// A name being typed.
pub(super) struct Naming {
	pub(super) target: NameTarget,
	pub(super) editor: Entity<Editor>,
	_subscription:     Subscription,
}

impl Naming {
	/// Whether this names the thread `session`.
	pub(super) fn is_session(&self, session: &SessionId) -> bool {
		matches!(&self.target, NameTarget::Session(id) if id == session)
	}

	/// Whether this names a profile.
	pub(super) const fn is_profile(&self) -> bool {
		!matches!(self.target, NameTarget::Session(_))
	}
}

impl Sidebar {
	/// Opens a field for `target` holding `initial`, and focuses it.
	pub(super) fn start_naming(
		&mut self,
		target: NameTarget,
		initial: &str,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		let editor = cx.new(|cx| {
			let mut editor = Editor::new(EditorMode::SingleLine, window, cx);
			editor.set_text(initial, cx);
			editor
		});
		let subscription =
			cx.subscribe_in(&editor, window, |this, _, event: &EditorEvent, window, cx| {
				this.on_name_event(*event, window, cx);
			});
		let focus = editor.focus_handle(cx);
		self.confirm_delete = None;
		self.naming = Some(Naming { target, editor, _subscription: subscription });
		window.focus(&focus, cx);
		cx.notify();
	}

	fn on_name_event(&mut self, event: EditorEvent, window: &mut Window, cx: &mut Context<Self>) {
		match event {
			EditorEvent::Submit | EditorEvent::Blurred => self.commit_name(window, cx),
			EditorEvent::Escape => self.cancel_naming(window, cx),
			_ => {},
		}
	}

	/// Sends the typed name for the target, unless it is empty or unchanged.
	fn commit_name(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		let Some(naming) = self.naming.take() else {
			return;
		};
		let name = naming.editor.read(cx).text().trim().to_owned();
		let sent = match naming.target {
			_ if name.is_empty() => None,
			NameTarget::Session(session) => {
				let unchanged = self
					.app
					.read(cx)
					.projects()
					.iter()
					.flat_map(|project| &project.sessions)
					.any(|row| row.id == session && row.title == name);
				(!unchanged).then(|| {
					let surface = SurfaceId::SessionRenameField(session.clone());
					(HostAction::RenameSession { session, title: name }, surface)
				})
			},
			NameTarget::NewProfile => Some((
				HostAction::CreateProfile { name, copy: Vec::new() },
				SurfaceId::ProfileCreateButton,
			)),
			NameTarget::Profile(profile) => Some((
				HostAction::RenameProfile { name: profile.clone(), display_name: name },
				SurfaceId::ProfileRenameButton(profile),
			)),
		};
		if let Some((action, surface)) = sent {
			self.app.update(cx, |app, cx| app.dispatch(action, surface, cx));
		}
		window.focus(&self.focus, cx);
		cx.notify();
	}

	/// Closes the field without sending.
	pub(super) fn cancel_naming(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		if self.naming.take().is_some() {
			window.focus(&self.focus, cx);
			cx.notify();
		}
	}
}
