//! What the thread header and the transcript read about the session they show.

use veyyon_desktop_model::{SessionId, SessionMode, StreamingMessageState, TranscriptAnchor};
use veyyon_gpui::Context;

use super::AppState;

impl AppState {
	/// The assistant message `session` is streaming, if one is in flight.
	pub fn streaming(&self, session: &SessionId) -> Option<&StreamingMessageState> {
		self.store.streaming.get(session)
	}

	/// Whether the agent is working in `session`: a reply is streaming or the
	/// host reports a working window open.
	pub fn is_working(&self, session: &SessionId) -> bool {
		self.store.streaming.contains_key(session)
			|| self
				.store
				.pace(session)
				.is_some_and(|pace| pace.working_since_ms.is_some())
	}

	/// The title the sidebar lists `session` under.
	pub fn session_title(&self, session: &SessionId) -> Option<&str> {
		self
			.projects
			.iter()
			.flat_map(|project| project.sessions.iter())
			.find(|row| &row.id == session)
			.map(|row| row.title.as_str())
	}

	/// The mode the host reports `session` running in.
	pub fn session_mode(&self, session: &SessionId) -> Option<&SessionMode> {
		self.store.modes.get(session)
	}

	/// Where the window was reading `session`, `None` at the live edge.
	pub fn read_position(&self, session: &SessionId) -> Option<&TranscriptAnchor> {
		self
			.store
			.persisted
			.transcripts
			.get(session)?
			.scroll_anchor
			.as_ref()
	}

	/// Records where the window is reading `session`, `None` at the live
	/// edge. An unchanged position writes nothing and schedules nothing.
	pub fn set_read_position(
		&mut self,
		session: SessionId,
		anchor: Option<TranscriptAnchor>,
		cx: &mut Context<Self>,
	) {
		if self.read_position(&session) == anchor.as_ref() {
			return;
		}
		self.remember(cx, |persisted| {
			persisted
				.transcripts
				.entry(session)
				.or_default()
				.scroll_anchor = anchor;
		});
	}
}
