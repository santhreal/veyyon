//! A store seeded without a host, projected the way the window projects it.
//!
//! A scene is a state of the protocol model, not a hand-built view model: the
//! fixtures come from the scene crate, the state goes through `project`,
//! `project_controls` and `land_failure`, so a scene shows what the window
//! would show for that model, and a projection defect shows in the catalogue.

use std::collections::HashMap;

use veyyon_desktop_model::{
	BackendError, BlockKind, Capability, CapabilityMap, CapabilityStatus, ConnectionState,
	ContentBlock, EntryId, ErrorScope, MessageRole, PROTOCOL_VERSION, QueuePartition,
	RequestRegistry, SessionBadge, SessionId, Store, TranscriptEntry, is_scope_retryable,
};
use veyyon_desktop_scene::{FixtureText, content_block_fixture, session_fixture};
use veyyon_desktop_surface::ShellState;

use crate::project::{SessionIndex, connection_notice, land_failure, project, project_controls};

/// The fixed clock every scene is measured against. Past every fixture
/// timestamp, so elapsed labels are positive and the same on every render.
pub const SCENE_CLOCK_MS: u64 = 1_700_000_100_000;

/// The endpoint the attached fixtures name.
const ENDPOINT: &str = "127.0.0.1:47000";

/// What a scene hands the view: the projected state and the attention line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Built {
	pub state:         ShellState,
	pub notice:        Option<String>,
	pub composer_text: String,
}

/// The protocol model under construction.
pub struct Seed {
	pub store:    Store,
	pub registry: RequestRegistry,
	pub state:    ShellState,
	pub notice:   Option<String>,
	next_session: u64,
}

impl Seed {
	/// A store as the host leaves it once attached: connected, every
	/// capability available, nothing listed yet.
	#[must_use]
	pub fn attached() -> Self {
		let mut store = Store::new();
		store.connection =
			ConnectionState::Connected { endpoint: ENDPOINT.to_string(), protocol: PROTOCOL_VERSION };
		for capability in Capability::ALL {
			store
				.capabilities
				.set(capability, CapabilityStatus::Available);
		}
		Self {
			store,
			registry: RequestRegistry::new(),
			state: ShellState::default(),
			notice: None,
			next_session: 0,
		}
	}

	/// A store in one connection state, with the notice the window shows.
	#[must_use]
	pub fn connection(state: ConnectionState) -> Self {
		let mut seed = Self::attached();
		if !matches!(state, ConnectionState::Connected { .. }) {
			seed.store.capabilities = CapabilityMap::new();
		}
		seed.notice = connection_notice(&state);
		seed.store.connection = state;
		seed
	}

	/// Lists one session in a partition and returns its id. The first
	/// session listed becomes the active one.
	pub fn session(&mut self, partition: QueuePartition, badge: Option<SessionBadge>) -> SessionId {
		let session = session_fixture(self.next_session, partition, badge);
		self.next_session += 1;
		let id = session.id.clone();
		self.store.sessions.insert(session);
		if self.store.persisted.shell.active_session.is_none() {
			self.store.persisted.shell.active_session = Some(id.clone());
		}
		id
	}

	/// Appends one entry to a session's transcript, parented to the entry
	/// before it, and returns its id.
	pub fn entry(&mut self, session: &SessionId, role: MessageRole, content: Vec<ContentBlock>) {
		let tree = self.store.transcripts.entry(session.clone()).or_default();
		let index = tree.entries.len() as u64;
		let parent = index
			.checked_sub(1)
			.map(|n| EntryId::from(format!("entry_{n:04}")));
		tree.append(TranscriptEntry {
			id: EntryId::from(format!("entry_{index:04}")),
			parent,
			revision: 1,
			timestamp_ms: SCENE_CLOCK_MS - 60_000 + index * 1000,
			role,
			content,
			meta: None,
			raw_discriminator: format!("{role:?}"),
			raw: serde_json::Value::Null,
		});
	}

	/// An operator prompt followed by one assistant entry holding the given
	/// blocks: the shortest transcript in which a block has context.
	pub fn exchange(&mut self, session: &SessionId, reply: Vec<ContentBlock>) {
		self.entry(session, MessageRole::User, vec![ContentBlock::Text {
			text: FixtureText::MESSAGE_TYPICAL.to_string(),
		}]);
		self.entry(session, MessageRole::Assistant, reply);
	}

	/// A prose block for a reply.
	#[must_use]
	pub fn prose() -> Vec<ContentBlock> {
		vec![content_block_fixture(1, BlockKind::Text)]
	}

	/// A backend failure of one scope with no request to land on, so it
	/// goes where the scope's fallback sends it.
	pub fn fail(&mut self, scope: ErrorScope) {
		let error = BackendError {
			scope,
			code: Some(format!("E_{}", scope.as_str().to_ascii_uppercase())),
			message: format!("{} request failed: fixture failure", scope.as_str()),
			retryable: is_scope_retryable(scope),
			request: None,
			occurred_at_ms: SCENE_CLOCK_MS - 1000,
		};
		let active = self.store.persisted.shell.active_session.clone();
		if let Some(line) = land_failure(&error, &self.registry, active.as_ref(), &mut self.state) {
			self.notice = Some(line);
		}
	}

	/// Projects the store onto the state, gates every control, and hands
	/// back what the view draws.
	#[must_use]
	pub fn finish(mut self) -> Built {
		let mut index = SessionIndex::new();
		project(&self.store, &mut index, &HashMap::new(), SCENE_CLOCK_MS, &mut self.state);
		project_controls(&self.store, &self.registry, &index, &mut self.state);
		Built { state: self.state, notice: self.notice, composer_text: String::new() }
	}
}
