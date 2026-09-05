//! From a scene's name to the state it shows (§9.4).
//!
//! The registry derives its required set from the protocol enums; this is the
//! other half, one builder per enum, so a variant the registry starts
//! requiring is a compile error here until it has a state. The sixteen named
//! scenes past the required set are built by name.

use strum::IntoEnumIterator as _;
use veyyon_desktop_model::{
	ApprovalInteraction, AuthFlowState, AuthFlowView, BadgeKind, BlockKind, Capability,
	CapabilityStatus, ConnectionState, ConnectionStateKind, ContextBreakdownView, ErrorScope,
	HostActionKind, InputModality, InteractionId, MessageRole, ModelRef, ModelView, ModelsView,
	PendingDecisions, QueuePartition, RequestId, SessionBadge, SettingEntry, SettingKind, SurfaceId,
	action_to_capability,
};
use veyyon_desktop_scene::{
	FixtureText, GateVariant, PrimitiveKind, RequiredState, RowShape, Scene, StateDescriptor,
	content_block_fixture, session_badge_fixture, transcript_entry_fixture,
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
			let session = seed.session(QueuePartition::Live, None);
			seed.entry(&session, MessageRole::User, vec![content_block_fixture(0, BlockKind::Text)]);
			let entry = transcript_entry_fixture(1, *role);
			seed.entry(&session, *role, entry.content);
			seed.finish()
		},
		RequiredState::Block(kind) => {
			let mut seed = Seed::attached();
			let session = seed.session(QueuePartition::Live, None);
			seed.exchange(&session, vec![content_block_fixture(1, *kind)]);
			seed.finish()
		},
		RequiredState::Error(scope) => error_scope(*scope),
		RequiredState::Badge(kind) => {
			let mut seed = Seed::attached();
			let session = seed.session(QueuePartition::Live, Some(session_badge_fixture(*kind)));
			seed.exchange(&session, Seed::prose());
			seed.finish()
		},
		RequiredState::Section(partition) => {
			let mut seed = Seed::attached();
			seed.session(*partition, None);
			seed.finish()
		},
		RequiredState::RowShape(shape) => {
			let mut seed = Seed::attached();
			let partition = match shape {
				RowShape::Card => QueuePartition::Live,
				RowShape::Line => QueuePartition::Parked,
			};
			seed.session(partition, Some(SessionBadge::Done));
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

/// The first host action a capability gates, if any gates one.
fn action_of(capability: Capability) -> Option<HostActionKind> {
	HostActionKind::iter().find(|kind| action_to_capability(*kind) == capability)
}

/// The attached window with one capability in one gate state.
fn capability_gate(
	name: &str,
	capability: Capability,
	gate: GateVariant,
) -> Result<Built, SceneBuildError> {
	let mut seed = Seed::attached();
	let session = seed.session(QueuePartition::Live, None);
	seed.exchange(&session, Seed::prose());
	let status = match gate {
		GateVariant::Enabled => CapabilityStatus::Available,
		GateVariant::Unknown => CapabilityStatus::UnknownUntilAttached,
		GateVariant::Unavailable => CapabilityStatus::Unavailable {
			reason: format!("{} is not available on this host", capability.as_str()),
		},
		GateVariant::Pending => {
			let action = action_of(capability).ok_or_else(|| SceneBuildError::Unreachable {
				scene:  name.to_string(),
				reason: format!(
					"no host action is gated by {}, so no request of it can be in flight",
					capability.as_str()
				),
			})?;
			seed.registry.register(
				RequestId(1),
				action,
				SurfaceId::GlobalTitlebarLine,
				SCENE_CLOCK_MS - 500,
				30_000,
			);
			CapabilityStatus::Available
		},
	};
	seed.store.capabilities.set(capability, status);
	Ok(seed.finish())
}

/// The attached window after a failure of one scope with no request.
fn error_scope(scope: ErrorScope) -> Built {
	let mut seed = Seed::attached();
	let session = seed.session(QueuePartition::Live, None);
	seed.exchange(&session, Seed::prose());
	seed.fail(scope);
	seed.finish()
}

fn custom(name: &str, surface: &str, state: &str) -> Result<SceneRoot, SceneBuildError> {
	let built = match (surface, state) {
		("queue-card", badge) => queue_row(QueuePartition::Live, badge)?,
		("queue-line", badge) => queue_row(QueuePartition::Parked, badge)?,
		("section-header", "rest") => {
			let mut seed = Seed::attached();
			for partition in QueuePartition::iter() {
				seed.session(partition, None);
			}
			seed.finish()
		},
		("composer" | "opening-line", "rest") => {
			let mut seed = Seed::attached();
			seed.session(QueuePartition::Live, None);
			seed.finish()
		},
		("composer", "footer") => composer_footer(),
		("run-bar", "rest") => {
			let mut seed = Seed::attached();
			let session = seed.session(
				QueuePartition::Live,
				Some(SessionBadge::Working { started_at_ms: SCENE_CLOCK_MS - 12_000 }),
			);
			seed.exchange(&session, Seed::prose());
			seed.finish()
		},
		("palette", "rest") => {
			let mut seed = Seed::attached();
			seed.session(QueuePartition::Live, None);
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

/// One row in a partition, with the badge the state names; `rest` is none.
/// An approval also raises the decision the badge stands for.
fn queue_row(partition: QueuePartition, badge: &str) -> Result<Built, SceneBuildError> {
	let kind = match badge {
		"rest" => None,
		"approval" => Some(BadgeKind::Approval),
		"working" => Some(BadgeKind::Working),
		"watching" => Some(BadgeKind::Watching),
		other => return Err(SceneBuildError::Unbuilt(format!("queue row badge {other}"))),
	};
	let mut seed = Seed::attached();
	let session = seed.session(partition, kind.map(session_badge_fixture));
	seed.exchange(&session, Seed::prose());
	if kind == Some(BadgeKind::Approval) {
		seed.store.interactions.insert(session, PendingDecisions {
			approvals: vec![ApprovalInteraction {
				id:              InteractionId::from("approval_0001"),
				tool_name:       "bash".to_string(),
				detail:          "rm -rf target/desktop-scenes".to_string(),
				requested_at_ms: SCENE_CLOCK_MS - 4000,
			}],
			..PendingDecisions::new()
		});
	}
	Ok(seed.finish())
}

/// The composer with every footer control the host can report.
fn composer_footer() -> Built {
	let mut seed = Seed::attached();
	let session = seed.session(QueuePartition::Live, None);
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
	seed.session(QueuePartition::Live, None);
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
