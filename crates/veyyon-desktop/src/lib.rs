pub mod bridge;
pub mod cli;
pub mod endpoint;
pub mod framing;
pub mod launch;
pub mod link;
pub mod notify;
pub mod reconnect;
pub mod state;
pub mod transport;

pub use bridge::{
	ActionClassification, EGRESS_CAPACITY, EgressBridge, EgressError, INGRESS_CAPACITY,
	MUTATION_TIMEOUT_MS, classify_action, create_egress_channel, create_ingress_channel,
	current_timestamp_ms,
};
pub use endpoint::{
	AttachError, Attachment, ChildHostHandle, DEFAULT_SOCKET_FILENAME, Endpoint, EndpointError,
	HostSpawnError, HostStderr, SPAWN_WAIT_MS, VEYYON_BIN_ENV, VEYYON_GUI_ENDPOINT_ENV,
	VEYYON_PROFILE_ENV, accepts_connection, check_unix_path, connect_or_spawn, default_agent_dir,
	gui_host_socket_path, last_words, runtime_directory, runtime_socket_path, spawn_child_host,
	spawn_host_binary, unix_path_fits, unix_path_limit,
};
pub use framing::{FrameDecoder, FramingError, MAX_FRAME_BYTES, encode_request};
pub use link::{HostLink, TRANSPORT_THREAD_NAME};
pub use notify::{
	Carrier, DesktopCarrier, NoticeCarrier, NoticeDelivery, SOUND_SETTING, SYSTEM_SETTING,
	announcement_sound, system_notification,
};
pub use reconnect::{
	DeterministicJitter, FATAL_MESSAGE, INITIAL_DELAY_MS, JITTER_PCT, JitterSource, MAX_ATTEMPTS,
	MAX_DELAY_MS, MAX_ELAPSED_MS, MULTIPLIER, ReconnectError, ReconnectPolicy, SeededJitter,
	ZeroJitter, base_delay_ms, delay_with_jitter_factor, max_jitter_delay_ms, min_jitter_delay_ms,
};
pub use transport::{
	HandshakeDriver, TransportError, apply_event_to_store, initial_sync_actions, spawn_transport,
};
