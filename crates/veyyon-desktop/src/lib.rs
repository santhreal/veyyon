pub mod bridge;
pub mod endpoint;
pub mod framing;
pub mod reconnect;
pub mod transport;

pub use bridge::{
	ActionClassification, EGRESS_CAPACITY, EgressBridge, EgressError, INGRESS_CAPACITY,
	MUTATION_TIMEOUT_MS, classify_action, create_egress_channel, create_ingress_channel,
};
pub use endpoint::{
	DEFAULT_SOCKET_FILENAME, Endpoint, EndpointError, HostSpawnError, VEYYON_GUI_ENDPOINT_ENV,
	spawn_child_host,
};
pub use framing::{FrameDecoder, FramingError, MAX_FRAME_BYTES, encode_request};
pub use reconnect::{
	DeterministicJitter, FATAL_MESSAGE, INITIAL_DELAY_MS, JITTER_PCT, JitterSource, MAX_ATTEMPTS,
	MAX_DELAY_MS, MAX_ELAPSED_MS, MULTIPLIER, ReconnectError, ReconnectPolicy, SeededJitter,
	ZeroJitter, base_delay_ms, delay_with_jitter_factor, max_jitter_delay_ms, min_jitter_delay_ms,
};
pub use transport::{
	HandshakeDriver, TransportError, apply_event_to_store, initial_sync_actions, spawn_transport,
};
