pub mod app;
pub mod bridge;
pub mod endpoint;
pub mod framing;
pub mod link;
pub mod project;
pub mod reconnect;
pub mod transport;

pub use app::{
	AssetPaths, StartupBundle, discover_asset_paths, load_startup_bundle, start_token_supervision,
};
pub use bridge::{
	ActionClassification, EGRESS_CAPACITY, EgressBridge, EgressError, INGRESS_CAPACITY,
	MUTATION_TIMEOUT_MS, classify_action, create_egress_channel, create_ingress_channel,
	current_timestamp_ms,
};
pub use endpoint::{
	AttachError, Attachment, ChildHostHandle, DEFAULT_SOCKET_FILENAME, Endpoint, EndpointError,
	HostSpawnError, SPAWN_WAIT_MS, VEYYON_BIN_ENV, VEYYON_GUI_ENDPOINT_ENV, VEYYON_PROFILE_ENV,
	accepts_connection, connect_or_spawn, default_agent_dir, spawn_child_host,
};
pub use framing::{FrameDecoder, FramingError, MAX_FRAME_BYTES, encode_request};
pub use link::{HostLink, TRANSPORT_THREAD_NAME};
pub use project::{
	PANE_LINE_CEILING, SessionIndex, actions_for, drawer_lines, elapsed_label, project,
	strip_control_sequences, tree_rows,
};
pub use reconnect::{
	DeterministicJitter, FATAL_MESSAGE, INITIAL_DELAY_MS, JITTER_PCT, JitterSource, MAX_ATTEMPTS,
	MAX_DELAY_MS, MAX_ELAPSED_MS, MULTIPLIER, ReconnectError, ReconnectPolicy, SeededJitter,
	ZeroJitter, base_delay_ms, delay_with_jitter_factor, max_jitter_delay_ms, min_jitter_delay_ms,
};
pub use transport::{
	HandshakeDriver, TransportError, apply_event_to_store, initial_sync_actions, spawn_transport,
};
