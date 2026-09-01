use std::{collections::HashSet, time::SystemTime};

use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use veyyon_desktop_model::{
	Capability, CapabilityStatus, ConnectionState, DamageSet, HostAction, HostEvent, HostRequest,
	PROTOCOL_VERSION, RequestId, SnapshotSection, Store, reduce,
};

use crate::{
	bridge::{EgressBridge, create_egress_channel, create_ingress_channel},
	endpoint::Endpoint,
	framing::{FrameDecoder, encode_request},
	reconnect::{FATAL_MESSAGE, ReconnectPolicy},
};

/// Errors originating from the transport and handshake lifecycle.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum TransportError {
	#[error("Protocol version mismatch: {0}")]
	FatalProtocol(String),
	#[error("Connection fatal error: {0}")]
	Fatal(String),
	#[error("Socket I/O error: {0}")]
	Io(String),
	#[error("Handshake aborted: {0}")]
	HandshakeAborted(String),
}

/// Dispatches initial sync actions based on host capability statuses (§8.12).
///
/// `ListSessions` is unconditional. Domain snapshots (`Settings`, `Themes`,
/// etc.) are dispatched ONLY when their corresponding capability is reported as
/// [`CapabilityStatus::Available`].
#[must_use]
pub fn initial_sync_actions(capabilities: &[(Capability, CapabilityStatus)]) -> Vec<HostAction> {
	let mut actions = Vec::new();

	// Sessions capability is the primary sync prerequisite
	actions.push(HostAction::ListSessions);

	for (cap, status) in capabilities {
		if *status != CapabilityStatus::Available {
			continue;
		}

		let maybe_action = match cap {
			Capability::Settings => Some(HostAction::LoadSettings),
			Capability::Themes => Some(HostAction::LoadThemes),
			Capability::Keybindings => Some(HostAction::LoadKeybindings),
			Capability::Models => Some(HostAction::RefreshModels),
			Capability::Providers => Some(HostAction::RefreshProviders),
			Capability::Mcp => Some(HostAction::RefreshMcp),
			Capability::Diagnostics => Some(HostAction::RefreshDiagnostics),
			Capability::Changes => Some(HostAction::RefreshChanges),
			Capability::ProcessSupervisor => Some(HostAction::RefreshProcesses),
			_ => None,
		};

		if let Some(action) = maybe_action {
			actions.push(action);
		}
	}

	actions
}

/// State machine driving protocol version negotiation, capability sync, and
/// connection settlement.
#[derive(Debug)]
pub struct HandshakeDriver {
	endpoint_str:            String,
	state:                   ConnectionState,
	expected_sync_requests:  HashSet<RequestId>,
	received_settlements:    u32,
	expected_count:          Option<u32>,
	initial_sync_dispatched: bool,
	next_request_id:         u64,
	handshake_complete:      bool,
}

impl HandshakeDriver {
	/// Creates a new handshake driver in [`ConnectionState::Connecting`].
	#[must_use]
	pub fn new(endpoint_str: String) -> Self {
		Self {
			endpoint_str,
			state: ConnectionState::Connecting { attempt: 1 },
			expected_sync_requests: HashSet::new(),
			received_settlements: 0,
			expected_count: None,
			initial_sync_dispatched: false,
			next_request_id: 1,
			handshake_complete: false,
		}
	}

	/// Returns current connection state.
	#[must_use]
	pub const fn state(&self) -> &ConnectionState {
		&self.state
	}

	/// Returns true if the handshake reached [`ConnectionState::Connected`].
	#[must_use]
	pub const fn is_connected(&self) -> bool {
		matches!(self.state, ConnectionState::Connected { .. })
	}

	/// Returns true if the connection is in terminal [`ConnectionState::Fatal`].
	#[must_use]
	pub const fn is_fatal(&self) -> bool {
		matches!(self.state, ConnectionState::Fatal { .. })
	}

	/// Allocates a new monotonically increasing [`RequestId`].
	const fn alloc_id(&mut self) -> RequestId {
		let id = self.next_request_id;
		self.next_request_id = self.next_request_id.saturating_add(1);
		RequestId(id)
	}

	/// Ingests an incoming [`HostEvent`] and returns any outbound requests to
	/// send immediately.
	pub fn handle_event(&mut self, event: &HostEvent) -> Result<Vec<HostRequest>, TransportError> {
		if self.handshake_complete {
			return Ok(Vec::new());
		}

		match event {
			HostEvent::ConnectionChanged(ConnectionState::Connected { endpoint, protocol }) => {
				if *protocol != PROTOCOL_VERSION {
					let message = format!(
						"Protocol version mismatch: client expects protocol v{PROTOCOL_VERSION}, host \
						 vended v{protocol}"
					);
					self.state = ConnectionState::Fatal { message: message.clone() };
					return Err(TransportError::FatalProtocol(message));
				}
				self.endpoint_str.clone_from(endpoint);
			},

			HostEvent::Snapshot(SnapshotSection::Capabilities(caps))
				if !self.initial_sync_dispatched =>
			{
				let actions = initial_sync_actions(caps);
				let mut requests = Vec::with_capacity(actions.len());

				for action in actions {
					let id = self.alloc_id();
					self.expected_sync_requests.insert(id);
					requests.push(HostRequest { id, action });
				}

				let total = u32::try_from(requests.len()).unwrap_or(u32::MAX);
				self.expected_count = Some(total);
				self.received_settlements = 0;
				self.state = ConnectionState::Syncing { received: 0, expected: self.expected_count };
				self.initial_sync_dispatched = true;

				if self.expected_sync_requests.is_empty() {
					self.state = ConnectionState::Connected {
						endpoint: self.endpoint_str.clone(),
						protocol: PROTOCOL_VERSION,
					};
					self.handshake_complete = true;
				}

				return Ok(requests);
			},

			HostEvent::RequestSucceeded { request } => {
				self.settle_request(*request);
			},

			HostEvent::RequestFailed { request, .. } => {
				self.settle_request(*request);
			},

			HostEvent::FatalProtocolError { message } => {
				self.state = ConnectionState::Fatal { message: message.clone() };
				return Err(TransportError::FatalProtocol(message.clone()));
			},

			_ => {},
		}

		Ok(Vec::new())
	}

	/// Marks a sync request as settled, transitioning to `Connected` once all
	/// have settled.
	fn settle_request(&mut self, request_id: RequestId) {
		if self.expected_sync_requests.remove(&request_id) {
			self.received_settlements = self.received_settlements.saturating_add(1);
			self.state = ConnectionState::Syncing {
				received: self.received_settlements,
				expected: self.expected_count,
			};

			if self.expected_sync_requests.is_empty() {
				self.state = ConnectionState::Connected {
					endpoint: self.endpoint_str.clone(),
					protocol: PROTOCOL_VERSION,
				};
				self.handshake_complete = true;
			}
		}
	}
}

/// Applies an inbound event to the store via [`reduce`], returning the
/// resulting [`DamageSet`].
///
/// Ensures the transport thread does not mutate [`Store`] fields directly.
#[must_use]
pub fn apply_event_to_store(store: &mut Store, event: HostEvent) -> DamageSet {
	reduce(store, event)
}

/// Spawns the background transport supervisor and returns the [`EgressBridge`]
/// and channels.
#[must_use]
pub fn spawn_transport(
	endpoint: Endpoint,
) -> (EgressBridge, tokio::sync::mpsc::Receiver<HostEvent>, tokio::task::JoinHandle<()>) {
	let (ingress_tx, ingress_rx) = create_ingress_channel();
	let (egress_tx, mut egress_rx) = create_egress_channel();
	let egress_bridge = EgressBridge::new(egress_tx);

	let join_handle = tokio::spawn(async move {
		let mut reconnect_policy = ReconnectPolicy::default();
		let mut decoder = FrameDecoder::new();
		let mut read_buf = [0u8; 8192];

		loop {
			let endpoint_str = endpoint.formatted();
			let _ = ingress_tx
				.send(HostEvent::ConnectionChanged(ConnectionState::Connecting {
					attempt: reconnect_policy.attempt().saturating_add(1),
				}))
				.await;

			let connect_result = match &endpoint {
				Endpoint::Tcp { host, port } => {
					tokio::net::TcpStream::connect(format!("{host}:{port}"))
						.await
						.map(tokio_util::either::Either::Left)
				},
				Endpoint::Unix { path } => tokio::net::UnixStream::connect(path)
					.await
					.map(tokio_util::either::Either::Right),
			};

			let stream = match connect_result {
				Ok(s) => s,
				Err(err) => {
					let Ok(delay) = reconnect_policy.next_delay() else {
						let _ = ingress_tx
							.send(HostEvent::ConnectionChanged(ConnectionState::Fatal {
								message: FATAL_MESSAGE.to_string(),
							}))
							.await;
						break;
					};

					let retry_at_ms = SystemTime::now()
						.duration_since(SystemTime::UNIX_EPOCH)
						.map_or(0, |d| {
							u64::try_from(d.as_millis().saturating_add(delay.as_millis()))
								.unwrap_or(u64::MAX)
						});

					let _ = ingress_tx
						.send(HostEvent::ConnectionChanged(ConnectionState::Reconnecting {
							attempt: reconnect_policy.attempt(),
							retry_at_ms,
							message: err.to_string(),
						}))
						.await;

					tokio::time::sleep(delay).await;
					continue;
				},
			};

			let mut handshake = HandshakeDriver::new(endpoint_str);
			decoder.clear();
			let mut socket_active = true;

			let (mut reader, mut writer) = tokio::io::split(stream);

			while socket_active {
				tokio::select! {
					read_res = reader.read(&mut read_buf) => {
						match read_res {
							Ok(0) => {
								socket_active = false;
							}
							Ok(n) => {
								let chunk = match read_buf.get(..n) {
									Some(c) => c,
									None => &[],
								};
								match decoder.decode_chunk(chunk) {
									Ok(events) => {
										for event in events {
											if !handshake.is_connected() {
												match handshake.handle_event(&event) {
													Ok(outbound_reqs) => {
														for req in outbound_reqs {
															if let Ok(encoded) = encode_request(&req) {
																let _ = writer.write_all(&encoded).await;
															}
														}
													}
													Err(TransportError::FatalProtocol(msg)) => {
														let _ = ingress_tx.send(HostEvent::FatalProtocolError { message: msg }).await;
														socket_active = false;
														break;
													}
													Err(_) => {}
												}
											}
											if ingress_tx.send(event).await.is_err() {
												socket_active = false;
												break;
											}
										}
									}
									Err(err) => {
										let _ = ingress_tx.send(HostEvent::FatalProtocolError { message: err.to_string() }).await;
										socket_active = false;
									}
								}
							}
							Err(_) => {
								socket_active = false;
							}
						}
					}
					Some(request) = egress_rx.recv() => {
						if let Ok(encoded) = encode_request(&request)
							&& writer.write_all(&encoded).await.is_err() {
								socket_active = false;
							}
					}
				}
			}

			if handshake.is_fatal() {
				break;
			}

			// Transition to Reconnecting
			let Ok(delay) = reconnect_policy.next_delay() else {
				let _ = ingress_tx
					.send(HostEvent::ConnectionChanged(ConnectionState::Fatal {
						message: FATAL_MESSAGE.to_string(),
					}))
					.await;
				break;
			};

			let retry_at_ms = SystemTime::now()
				.duration_since(SystemTime::UNIX_EPOCH)
				.map_or(0, |d| {
					u64::try_from(d.as_millis().saturating_add(delay.as_millis())).unwrap_or(u64::MAX)
				});

			let _ = ingress_tx
				.send(HostEvent::ConnectionChanged(ConnectionState::Reconnecting {
					attempt: reconnect_policy.attempt(),
					retry_at_ms,
					message: "Socket connection lost".to_string(),
				}))
				.await;

			tokio::time::sleep(delay).await;
		}
	});

	(egress_bridge, ingress_rx, join_handle)
}
