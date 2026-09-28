//! The right panel's and the terminal drawer's reads and writes of the
//! persisted layout and the local review threads.
//!
//! The tab each system shows and the diff layout are the operator's, per
//! session, in [`PersistedState::panels`]; the review threads are one
//! window-local document in [`PersistedState::reviews`]. Neither is a host
//! domain, so writing one emits no [`StoreEvent`]: the view that wrote it
//! notifies itself.
//!
//! [`PersistedState::panels`]: veyyon_desktop_model::PersistedState::panels
//! [`PersistedState::reviews`]: veyyon_desktop_model::PersistedState::reviews
//! [`StoreEvent`]: super::StoreEvent

use veyyon_desktop_model::{
	DiffMode, Gate, HostActionKind, PanelsStore, SessionId, gate_kind, review::ReviewsStore,
};

use super::AppState;

impl AppState {
	/// The layout the operator left `session`'s panel and drawer in, absent
	/// until they changed it.
	pub fn panels(&self, session: &SessionId) -> Option<&PanelsStore> {
		self.store.persisted.panels.get(session)
	}

	/// The right panel tab the displayed session shows, by its stable name.
	pub fn active_right_tab(&self) -> Option<&str> {
		self
			.displayed_panels()
			.and_then(|panels| panels.active_right_tab.as_deref())
	}

	/// The drawer tab the displayed session shows, by its stable name.
	pub fn active_drawer_tab(&self) -> Option<&str> {
		self
			.displayed_panels()
			.and_then(|panels| panels.active_drawer_tab.as_deref())
	}

	/// How the displayed session's diff is laid out.
	pub fn diff_mode(&self) -> DiffMode {
		self
			.displayed_panels()
			.map_or_else(DiffMode::default, |panels| panels.diff_mode)
	}

	/// Records `tab` as the right panel tab of the displayed session. Does
	/// nothing while no session is displayed.
	pub fn set_active_right_tab(&mut self, tab: &str) {
		self.with_displayed_panels(|panels| panels.active_right_tab = Some(tab.to_owned()));
	}

	/// Records `tab` as the drawer tab of the displayed session. Does nothing
	/// while no session is displayed.
	pub fn set_active_drawer_tab(&mut self, tab: &str) {
		self.with_displayed_panels(|panels| panels.active_drawer_tab = Some(tab.to_owned()));
	}

	/// Records `mode` as the displayed session's diff layout. Does nothing
	/// while no session is displayed.
	pub fn set_diff_mode(&mut self, mode: DiffMode) {
		self.with_displayed_panels(|panels| panels.diff_mode = mode);
	}

	/// The window-local review threads.
	pub const fn reviews(&self) -> &ReviewsStore {
		&self.store.persisted.reviews
	}

	/// The window-local review threads, to add, answer or resolve one.
	pub const fn reviews_mut(&mut self) -> &mut ReviewsStore {
		&mut self.store.persisted.reviews
	}

	/// The reason the host gave for not taking an action of `kind`, which a
	/// panel or drawer control draws in place of acting. Absent when the host
	/// takes it, while one is in flight, and before it states its
	/// capabilities.
	pub fn panel_unavailable(&self, kind: HostActionKind) -> Option<String> {
		match gate_kind(kind, &self.store.capabilities, &self.registry) {
			Gate::Unavailable { reason } => Some(reason),
			Gate::Enabled | Gate::Pending { .. } | Gate::Unknown => None,
		}
	}

	/// Whether a request of `kind` is in flight, which a refresh control
	/// draws as a spinner.
	pub fn panel_pending(&self, kind: HostActionKind) -> bool {
		self.registry.find_pending_for_action(kind).is_some()
	}

	fn displayed_panels(&self) -> Option<&PanelsStore> {
		self
			.displayed
			.as_ref()
			.and_then(|session| self.store.persisted.panels.get(session))
	}

	fn with_displayed_panels(&mut self, write: impl FnOnce(&mut PanelsStore)) {
		if let Some(session) = self.displayed.clone() {
			write(self.store.persisted.panels.entry(session).or_default());
		}
	}
}
