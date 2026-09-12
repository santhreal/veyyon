//! WHY THIS SUITE EXISTS
//!
//! Every other test in this crate decodes bytes this crate wrote. That proves
//! the codec agrees with itself and nothing about whether it agrees with the
//! host. The protocol types were transcribed from
//! `packages/coding-agent/src/gui-host/wire.ts`, and a transcription is exactly
//! the kind of thing that is wrong in one field.
//!
//! THE CLASS THIS CLOSES: a divergence between these Rust types and the real
//! frames the host emits. Decoding a live frame fails on a renamed field, a
//! changed tagging style, or a variant the enum does not carry, none of which a
//! round-trip against ourselves can see.
//!
//! WHAT IT DOES NOT CATCH: anything the host does not exercise in a handshake
//! and a session listing. It is ignored by default because it needs a running
//! host; `VEYYON_GUI_ENDPOINT` points it at one.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use veyyon_desktop::{Endpoint, FrameDecoder, HandshakeDriver, encode_request};
use veyyon_desktop_model::{HostEvent, SnapshotSection};

#[tokio::test]
#[ignore = "requires a live gui host; set VEYYON_GUI_ENDPOINT and run with --ignored"]
async fn live_host_completes_handshake_and_answers_list_sessions() {
	let raw =
		std::env::var("VEYYON_GUI_ENDPOINT").unwrap_or_else(|_| "tcp:127.0.0.1:7654".to_owned());
	let endpoint = Endpoint::parse(&raw, None).expect("valid tcp endpoint");

	let Endpoint::Tcp { host, port } = &endpoint else {
		panic!("expected TCP endpoint");
	};

	let mut stream = tokio::net::TcpStream::connect(format!("{host}:{port}"))
		.await
		.expect("failed to connect to live host on 127.0.0.1:7654");

	let mut decoder = FrameDecoder::new();
	let mut handshake = HandshakeDriver::new(endpoint.formatted());
	let mut read_buf = [0u8; 8192];
	let mut sessions_received = false;

	let timeout_deadline = tokio::time::sleep(Duration::from_secs(5));
	tokio::pin!(timeout_deadline);

	loop {
		tokio::select! {
			() = &mut timeout_deadline => {
				panic!("live host interaction timed out after 5s");
			}
			read_res = stream.read(&mut read_buf) => {
				let n = read_res.expect("read from socket failed");
				assert!(n > 0, "unexpected EOF from live host");

				let chunk = match read_buf.get(..n) {
					Some(c) => c,
					None => &[],
				};
				let events = decoder.decode_chunk(chunk).expect("valid frame decoding");

				for event in events {
					if !handshake.is_connected() {
						let outbound = handshake.handle_event(&event).expect("handshake step");
						for req in outbound {
							let encoded = encode_request(&req).expect("encode request");
							stream.write_all(&encoded).await.expect("write request");
						}
					}

					if let HostEvent::Snapshot(SnapshotSection::Sessions(sessions, errors)) = event {
						sessions_received = true;
						assert!(
							errors.is_empty(),
							"a healthy host answers ListSessions with no errors, got {errors:?}",
						);
						assert!(
							sessions.revision > 0,
							"a snapshot carries the revision it was stamped with, got {}",
							sessions.revision,
						);
						// Reaching here means every session summary in the live
						// payload deserialised into the Rust type, which is the
						// contract this test exists for.
						for summary in &sessions.value {
							assert!(!summary.id.0.is_empty(), "a session summary carries an id");
						}
					}
				}

				if handshake.is_connected() && sessions_received {
					break;
				}
			}
		}
	}

	assert!(handshake.is_connected(), "handshake must be connected");
	assert!(sessions_received, "sessions snapshot must have been received from live host");
}
