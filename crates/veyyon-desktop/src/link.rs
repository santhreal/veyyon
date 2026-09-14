//! The window's end of the transport (§8.4, §8.11).
//!
//! The transport runs on its own Tokio runtime, on its own OS thread, and the
//! window reaches it through two bounded channels: events in, requests out.
//! `HostLink` owns the runtime and mints request ids, so the UI thread never
//! enters Tokio and the transport never touches a view.

use std::{cell::Cell, io};

use tokio::{
	runtime::{Builder, Handle, Runtime},
	sync::mpsc::{Receiver, Sender, channel},
};
use veyyon_desktop_model::{
	BackendError, ErrorScope, HostAction, HostEvent, HostRequest, RequestId,
};

use crate::{
	bridge::{EgressBridge, EgressError, INGRESS_CAPACITY, current_timestamp_ms},
	endpoint::Endpoint,
	transport::spawn_transport,
};

/// The name of the OS thread the transport runtime runs on.
pub const TRANSPORT_THREAD_NAME: &str = "veyyon-desktop-transport";

/// The window's handle on the transport.
#[derive(Debug)]
pub struct HostLink {
	/// Kept for its lifetime: dropping the runtime stops the transport.
	_runtime:     Runtime,
	handle:       Handle,
	egress:       EgressBridge,
	events:       Sender<HostEvent>,
	next_request: Cell<u64>,
}

impl HostLink {
	/// Starts the transport against an endpoint.
	///
	/// Returns the link and the receiver every event for the window arrives
	/// on: what the host sent, and a `RequestFailed` for any request the
	/// bridge could not carry, so a dropped request is reported where the
	/// host's own refusals are.
	pub fn start(endpoint: Endpoint) -> Result<(Self, Receiver<HostEvent>), io::Error> {
		let runtime = Builder::new_multi_thread()
			.worker_threads(1)
			.thread_name(TRANSPORT_THREAD_NAME)
			.enable_all()
			.build()?;
		let handle = runtime.handle().clone();
		let (events, window_rx) = channel(INGRESS_CAPACITY);

		let egress = {
			let _guard = runtime.enter();
			let (egress, mut ingress_rx, _supervisor) = spawn_transport(endpoint);
			let forward = events.clone();
			handle.spawn(async move {
				while let Some(event) = ingress_rx.recv().await {
					if forward.send(event).await.is_err() {
						break;
					}
				}
			});
			egress
		};

		Ok((
			Self { _runtime: runtime, handle, egress, events, next_request: Cell::new(1) },
			window_rx,
		))
	}

	/// Sends an action to the host and returns the id its reply will carry.
	///
	/// The send is queued on the transport runtime and returns at once. A
	/// bridge failure arrives on the event receiver as `RequestFailed` for the
	/// returned id.
	pub fn send(&self, action: HostAction) -> RequestId {
		let id = RequestId(self.next_request.get());
		self.next_request.set(id.0.wrapping_add(1));
		let egress = self.egress.clone();
		let events = self.events.clone();
		self.handle.spawn(async move {
			if let Err(failure) = egress.send(HostRequest { id, action }).await {
				let error = match failure {
					EgressError::DroppedEphemeral { error, .. }
					| EgressError::MutationTimeout { error, .. } => error,
					EgressError::ChannelClosed => BackendError {
						scope:          ErrorScope::Connection,
						code:           Some("CHANNEL_CLOSED".to_string()),
						message:        "the transport has stopped; restart the window to reconnect"
							.to_string(),
						retryable:      false,
						request:        Some(id),
						occurred_at_ms: current_timestamp_ms(),
					},
				};
				let _ = events
					.send(HostEvent::RequestFailed { request: id, error })
					.await;
			}
		});
		id
	}
}
