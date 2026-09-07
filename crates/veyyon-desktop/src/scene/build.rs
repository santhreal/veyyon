//! From a scene's name to the state it shows (§9.4).
//!
//! The registry derives its required set from the protocol enums; this is the
//! other half, one builder per enum, so a variant the registry starts
//! requiring is a compile error here until it has a state. The sixteen named
//! scenes past the required set are built by name.

#[path = "capability/mod.rs"]
mod capability;
pub use capability::{action_of, capability_gate, target_surface_of};
#[path = "error_scope.rs"]
mod error_scope_builder;
pub use error_scope_builder::{error_scope, error_scope_baseline};
use strum::IntoEnumIterator as _;
use veyyon_desktop_model::{
	AuthFlowState, AuthFlowView, BadgeKind, BlockKind, ConnectionState, ConnectionStateKind,
	ContextBreakdownView, InputModality, MessageRole, ModelRef, ModelView, ModelsView,
	QueuePartition, QueuedPrompts, SettingEntry, SettingKind,
};
use veyyon_desktop_scene::{
	FixtureText, PrimitiveKind, RequiredState, RowShape, Scene, StateDescriptor,
	content_block_fixture, transcript_entry_fixture,
};
use veyyon_desktop_surface::{Overlay, PaletteState};

use super::seed::{Built, SCENE_CLOCK_MS, Seed};

/// What a scene renders as.
///
/// A shell state is a whole window's worth of state and a primitive kind is
/// one byte; the box keeps a kit scene from carrying the window's size.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SceneRoot {
	/// The whole window in one state.
	Shell(Box<Built>),
	/// One kit primitive on the canvas.
	Primitive(PrimitiveKind),
}

/// Why a scene has no state.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SceneBuildError {
	/// The catalogue requires the state and nothing in the protocol can
	/// produce it, so a scene of it would be invented.
	#[error("{scene} is unreachable: {reason}")]
	Unreachable { scene: String, reason: String },
	/// A named scene the registry lists and this module has no builder for.
	#[error("{0} has no builder")]
	Unbuilt(String),
}

/// The state a scene shows.
pub fn build(scene: &Scene) -> Result<SceneRoot, SceneBuildError> {
	match &scene.state {
		StateDescriptor::Required(state) => required(&scene.name, state),
		StateDescriptor::Custom { surface, state } => custom(&scene.name, surface, state),
	}
}

fn required(name: &str, state: &RequiredState) -> Result<SceneRoot, SceneBuildError> {
	let built = match state {
		RequiredState::Primitive(kind) => return Ok(SceneRoot::Primitive(*kind)),
		RequiredState::Connection(kind) => Seed::connection(connection_state(*kind)).finish(),
		RequiredState::CapabilityGate { capability, gate } => {
			capability_gate(name, *capability, *gate)?
		},
		RequiredState::Role(role) => {
			let mut seed = Seed::attached();
			let session = seed.session(QueuePartition::Live);
			seed.entry(&session, MessageRole::User, vec![content_block_fixture(0, BlockKind::Text)]);
			let entry = transcript_entry_fixture(1, *role);
			seed.entry(&session, *role, entry.content);
			seed.finish()
		},
		RequiredState::Block(kind) => {
			let mut seed = Seed::attached();
			let session = seed.session(QueuePartition::Live);
			seed.exchange(&session, vec![content_block_fixture(1, *kind)]);
			seed.finish()
		},
		RequiredState::Error(scope) => error_scope(*scope),
		RequiredState::Badge(kind) => {
			let mut seed = Seed::attached();
			let session = seed.badged_session(QueuePartition::Live, *kind);
			seed.exchange(&session, Seed::prose());
			seed.finish()
		},
		RequiredState::Section(partition) => {
			let mut seed = Seed::attached();
			seed.session(*partition);
			seed.finish()
		},
		RequiredState::RowShape(shape) => {
			let mut seed = Seed::attached();
			let partition = match shape {
				RowShape::Card => QueuePartition::Live,
				RowShape::Line => QueuePartition::Parked,
			};
			seed.badged_session(partition, BadgeKind::Done);
			seed.finish()
		},
	};
	Ok(SceneRoot::Shell(Box::new(built)))
}

/// One value of every connection state, with the payload its surface owes.
fn connection_state(kind: ConnectionStateKind) -> ConnectionState {
	match kind {
		ConnectionStateKind::Detached => ConnectionState::Detached,
		ConnectionStateKind::Connecting => ConnectionState::Connecting { attempt: 2 },
		ConnectionStateKind::Syncing => ConnectionState::Syncing { received: 3, expected: Some(10) },
		ConnectionStateKind::Connected => ConnectionState::Connected {
			endpoint: "127.0.0.1:47000".to_string(),
			protocol: veyyon_desktop_model::PROTOCOL_VERSION,
		},
		ConnectionStateKind::Reconnecting => ConnectionState::Reconnecting {
			attempt:     1,
			retry_at_ms: SCENE_CLOCK_MS + 5000,
			message:     "connection reset by peer".to_string(),
		},
		ConnectionStateKind::Fatal => {
			ConnectionState::Fatal { message: "protocol version mismatch".to_string() }
		},
	}
}

fn custom(name: &str, surface: &str, state: &str) -> Result<SceneRoot, SceneBuildError> {
	let built = match (surface, state) {
		("queue-card", badge) => queue_row(QueuePartition::Live, badge)?,
		("queue-line", badge) => queue_row(QueuePartition::Parked, badge)?,
		("section-header", "rest") => {
			let mut seed = Seed::attached();
			for partition in QueuePartition::iter() {
				seed.session(partition);
			}
			seed.finish()
		},
		("composer" | "opening-line", "rest") => {
			let mut seed = Seed::attached();
			seed.session(QueuePartition::Live);
			seed.finish()
		},
		("composer", "footer") => composer_footer(),
		("composer", "queued") => composer_queued(),
		("run-bar", "rest") => {
			let mut seed = Seed::attached();
			let session = seed.badged_session(QueuePartition::Live, BadgeKind::Working);
			seed.exchange(&session, Seed::prose());
			// The bar's own content is the badge plus the detail the badge
			// cannot state, so the photograph carries both.
			seed.stream(&session, "bash");
			seed.finish()
		},
		("palette", "rest") => {
			let mut seed = Seed::attached();
			seed.session(QueuePartition::Live);
			seed.state.overlay = Some(Overlay::Palette(PaletteState::default()));
			seed.finish()
		},
		("settings-row", "rest") => settings_row(),
		("shell", "auth-needs-secret") => auth(AuthFlowState::AwaitingSecret, None),
		("shell", "auth-awaiting-external-url") => {
			auth(AuthFlowState::AwaitingBrowser, Some("https://auth.example.test/oauth"))
		},
		_ => return Err(SceneBuildError::Unbuilt(name.to_string())),
	};
	Ok(SceneRoot::Shell(Box::new(built)))
}

/// One row in a partition, in the state its badge is derived from; `rest` is
/// a read session with a finished turn, which carries none.
fn queue_row(partition: QueuePartition, badge: &str) -> Result<Built, SceneBuildError> {
	let kind = match badge {
		"rest" => None,
		"approval" => Some(BadgeKind::Approval),
		"working" => Some(BadgeKind::Working),
		"watching" => Some(BadgeKind::Watching),
		other => return Err(SceneBuildError::Unbuilt(format!("queue row badge {other}"))),
	};
	let mut seed = Seed::attached();
	let session = match kind {
		Some(kind) => seed.badged_session(partition, kind),
		None => seed.session(partition),
	};
	seed.exchange(&session, Seed::prose());
	Ok(seed.finish())
}

/// The composer of a running turn that is holding two prompts behind it: one
/// steering prompt, which enters the turn at its next boundary, and one
/// follow-up, which runs after it ends.
fn composer_queued() -> Built {
	let mut seed = Seed::attached();
	let session = seed.badged_session(QueuePartition::Live, BadgeKind::Working);
	seed.exchange(&session, Seed::prose());
	seed.stream(&session, "bash");
	seed.store.queued.insert(session, QueuedPrompts {
		steering:  vec!["check the migration path too".to_string()],
		follow_up: vec!["then summarise what changed".to_string()],
	});
	seed.finish()
}

/// The composer with every footer control the host can report.
fn composer_footer() -> Built {
	let mut seed = Seed::attached();
	let session = seed.session(QueuePartition::Live);
	seed.store.domains.models = Some(ModelsView {
		models:          vec![ModelView {
			provider:       "anthropic".to_string(),
			id:             "claude-sonnet-4.5".to_string(),
			name:           "Claude Sonnet 4.5".to_string(),
			reasoning:      true,
			context_window: 200_000,
			max_output:     64_000,
			input:          vec![InputModality::Text, InputModality::Image],
		}],
		current:         Some(ModelRef {
			provider: "anthropic".to_string(),
			id:       "claude-sonnet-4.5".to_string(),
		}),
		thinking_level:  Some("high".to_string()),
		thinking_levels: ["off", "low", "medium", "high"].map(str::to_owned).to_vec(),
	});
	seed
		.store
		.domains
		.context
		.insert(session.clone(), ContextBreakdownView {
			session,
			total_tokens: 82_400,
			limit_tokens: Some(200_000),
			categories: Vec::new(),
		});
	seed.finish()
}

/// The settings overlay over one boolean and one enum row.
fn settings_row() -> Built {
	let mut seed = Seed::attached();
	seed.session(QueuePartition::Live);
	let entry = |value: serde_json::Value, kind: SettingKind, label: &str| SettingEntry {
		value: value.clone(),
		default: value,
		source: "default".to_string(),
		kind,
		label: Some(label.to_string()),
		description: Some(FixtureText::MESSAGE_TYPICAL.to_string()),
		tab: Some("General".to_string()),
		group: None,
		values: Vec::new(),
		options: Vec::new(),
		min: None,
		max: None,
		global: false,
		advanced: false,
		hidden: false,
	};
	let mut settings = veyyon_desktop_model::SettingsView::new();
	settings.insert(
		"ui.compact".to_string(),
		entry(serde_json::Value::Bool(true), SettingKind::Boolean, "Compact rows"),
	);
	settings.insert(
		"ui.theme".to_string(),
		entry(serde_json::Value::String("dark".to_string()), SettingKind::String, "Theme"),
	);
	seed.store.domains.settings = Some(settings);
	seed.state.overlay = Some(Overlay::Settings(Box::default()));
	seed.finish()
}

/// The attach screen in one authentication phase.
fn auth(state: AuthFlowState, url: Option<&str>) -> Built {
	let mut seed = Seed::attached();
	seed.store.domains.auth_flow = Some(AuthFlowView {
		provider: "anthropic".to_string(),
		state,
		url: url.map(str::to_owned),
		prompt: Some("Paste the API key".to_string()),
		message: None,
	});
	seed.finish()
}
