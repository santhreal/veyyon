//! The window's side of §8.10: read the shape off the drawn window, hold each
//! changed store for its debounce window, and hand a session's shape back when
//! the operator opens it.
//!
//! One call does all of it, from the one place that already holds the window,
//! the store and a clock: `Keeper::sync`. Splitting it into a read pass and a
//! write pass invites the ordering defect it is written to avoid — a session
//! switch that restores the incoming session before the outgoing session's
//! draft was recorded writes the wrong text under the wrong key.

use std::collections::HashMap;

use veyyon_desktop_model::{PersistedState, SessionId, Store};
use veyyon_desktop_surface::ShellView;
use veyyon_gpui::{Bounds, Context, Pixels, Point, Size, Window, px};

use super::{
	StateDir, StateTracker, StateWriter,
	memory::{
		host_shape, record_geometry, record_host, record_session, record_space, session_shape,
	},
	writer::WriteFailure,
};

/// Holds what the window remembers between the drawn window and the disk.
#[derive(Debug)]
pub struct Keeper {
	writer:            StateWriter,
	tracker:           StateTracker,
	/// The session whose shape the drawn window is holding, which is what a
	/// record writes under. `None` before the host has reported one.
	session:           Option<SessionId>,
	space:             u64,
	attachments:       HashMap<SessionId, Vec<veyyon_desktop_surface::Attachment>>,
	empty_attachments: HashMap<u64, Vec<veyyon_desktop_surface::Attachment>>,
	restored:          bool,
	attachment_files:  super::attachment_files::AttachmentFiles,
	/// Whether the remembered session has been resolved against the host's
	/// list, so it is asked for once and not on every listing.
	reopen_resolved:   bool,
}

impl Keeper {
	/// A keeper over the directory the documents are in and the state the
	/// window started from.
	#[must_use]
	pub fn new(dir: StateDir, loaded: PersistedState) -> Self {
		Self {
			space:             loaded.shell.navigation.active().id,
			attachments:       HashMap::new(),
			empty_attachments: HashMap::new(),
			restored:          false,
			attachment_files:  super::attachment_files::AttachmentFiles::default(),
			writer:            StateWriter::new(dir),
			tracker:           StateTracker::new(loaded),
			session:           None,
			reopen_resolved:   false,
		}
	}

	/// Records the drawn window's shape, hands back the shape of a session the
	/// operator has just opened, and writes every document whose debounce
	/// window has passed.
	///
	/// Returns what could not be written, which the caller states once rather
	/// than on every frame.
	pub fn sync(
		&mut self,
		view: &mut ShellView,
		store: &mut Store,
		window: &Window,
		now_ms: u64,
		cx: &mut Context<ShellView>,
	) -> Vec<WriteFailure> {
		let drawn_host = view.host_shape();
		let mut drawn_session = view.session_shape();
		let mut failures = Vec::new();
		let attachments_ready = !view.attachments_loading();
		match self
			.attachment_files
			.paths(self.writer.dir().root(), &view.state().composer.attachments)
		{
			Ok(paths) => drawn_session.attachment_paths = paths,
			Err(error) => failures.push(WriteFailure {
				kind:   veyyon_desktop_model::StoreKind::Composer,
				reason: format!("Clipboard draft attachment was not saved: {error}"),
			}),
		}
		record_host(&mut store.persisted, &drawn_host);
		store.persisted.reviews.clone_from(view.review_store());
		record_geometry(
			&mut store.persisted,
			window.bounds(),
			window.is_maximized(),
			display_id(window, cx),
		);
		if failures.is_empty() && attachments_ready {
			record_session(&mut store.persisted, self.session.as_ref(), &drawn_session);
		}
		if attachments_ready {
			if let Some(session) = &self.session {
				self
					.attachments
					.insert(session.clone(), view.state().composer.attachments.clone());
			} else if self.restored {
				self
					.empty_attachments
					.insert(self.space, view.state().composer.attachments.clone());
			}
		}
		if (self.restored || !drawn_session.draft_text.is_empty())
			&& failures.is_empty()
			&& attachments_ready
		{
			record_space(
				&mut store.persisted,
				self.space,
				self.session.as_ref(),
				&drawn_host,
				&drawn_session,
			);
		}
		let host_active = store.persisted.shell.active_session.clone();
		if !store.persisted.shell.navigation.is_initialized()
			&& let Some(session) = &host_active
		{
			store.persisted.shell.navigation.opened(session.clone());
		}

		let space = store.persisted.shell.navigation.active().id;
		let active = store.persisted.shell.navigation.active().selected.clone();
		if active != self.session || space != self.space || !self.restored {
			// The outgoing session's shape is already recorded above, so the
			// incoming session's draft and layout replace it rather than
			// landing under the session the operator just left.
			if space != self.space {
				view.restore_host_shape(&host_shape(&store.persisted));
			}
			let shape = session_shape(&store.persisted, active.as_ref());
			let attachments = match &active {
				Some(session) => self.attachments.get(session),
				None => self.empty_attachments.get(&space),
			};
			view.restore_session_shape_with_attachments(&shape, attachments.map(Vec::as_slice), cx);
			self.session = active;
			self.space = space;
			self.restored = true;
		}
		view
			.state_mut()
			.navigation
			.clone_from(&store.persisted.shell.navigation);

		failures.extend(
			self
				.tracker
				.sync(&store.persisted, &mut self.writer, now_ms),
		);
		failures.extend(self.writer.flush_due(now_ms));
		failures
	}

	/// Puts the shape a previous window held for every session at once back on
	/// the window, before a host has reported anything.
	pub fn restore_host(&self, view: &mut ShellView) {
		view.restore_host_shape(&host_shape(self.tracker.last()));
		view.restore_review_store(&self.tracker.last().reviews);
	}

	/// The session to ask the host to reopen, once the host has listed what it
	/// has.
	///
	/// A remembered session the host no longer lists is dropped rather than
	/// left as the window's active session, which is §8.10's rule for the
	/// shell store: the active session is re-resolved from the protocol. The
	/// question is asked once, so a session the operator closes afterwards is
	/// not reopened under them.
	pub fn resolve_reopen(&mut self, store: &mut Store) -> Option<SessionId> {
		if self.reopen_resolved {
			return None;
		}
		let shell = &self.tracker.last().shell;
		let wanted = if shell.navigation.is_initialized() {
			shell.navigation.active().selected.clone()
		} else {
			shell.active_session.clone()
		};
		let Some(wanted) = wanted else {
			self.reopen_resolved = true;
			return None;
		};
		if store.sessions.items.is_empty() {
			// The list has not arrived, so a session missing from it is not
			// yet a session that is gone.
			return None;
		}
		self.reopen_resolved = true;
		if store.sessions.get(&wanted).is_some() {
			return Some(wanted);
		}
		if store.persisted.shell.active_session.as_ref() == Some(&wanted) {
			store.persisted.shell.active_session = None;
		}
		None
	}

	/// Writes everything waiting, for a clean shutdown (§8.10).
	pub fn flush_all(&mut self) -> Vec<WriteFailure> {
		self.writer.flush_all()
	}
}

/// The display the window is on, as the id the window store holds.
///
/// A display with no stable uuid is reported as no display rather than as one
/// under an id that names a different screen after a replug.
fn display_id(window: &Window, cx: &Context<ShellView>) -> Option<String> {
	window
		.display(cx)
		.and_then(|display| display.uuid().ok())
		.map(|uuid| uuid.to_string())
}

/// Where a window store reopens the window, and whether it opens maximised.
///
/// The remembered size is raised to the minimum the shell can draw at, and the
/// remembered origin is kept only while the window's own centre lands on a
/// display this machine has: a rect left on a monitor that has since been
/// unplugged is a window opened where nothing can reach it, so it is centred
/// on the first display instead (§8.10).
#[must_use]
pub fn placement(
	state: &PersistedState,
	displays: &[Bounds<Pixels>],
	min_width: f32,
	min_height: f32,
) -> (Bounds<Pixels>, bool) {
	let window = &state.window;
	let size = Size {
		width:  px(px_measure(window.width).max(min_width)),
		height: px(px_measure(window.height).max(min_height)),
	};
	let origin = Point { x: px(window.x as f32), y: px(window.y as f32) };
	let bounds = Bounds { origin, size };
	let centre = Point { x: origin.x + size.width / 2.0, y: origin.y + size.height / 2.0 };
	if displays.iter().any(|display| display.contains(&centre)) {
		return (bounds, window.maximized);
	}
	let Some(first) = displays.first() else {
		return (Bounds { origin: Point { x: px(0.0), y: px(0.0) }, size }, window.maximized);
	};
	(Bounds::centered_at(first.center(), size), window.maximized)
}

/// A remembered measure in pixels, with a stored zero meaning the store has
/// none rather than a window with no size.
const fn px_measure(value: u32) -> f32 {
	if value == 0 { 0.0 } else { value as f32 }
}
