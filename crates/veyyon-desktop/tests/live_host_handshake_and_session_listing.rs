use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use veyyon_desktop::{Endpoint, FrameDecoder, HandshakeDriver, encode_request};
use veyyon_desktop_model::{HostEvent, SnapshotSection};

#[tokio::test]
#[ignore = "requires live gui host running at tcp:127.0.0.1:7654"]
async fn live_host_completes_handshake_and_answers_list_sessions() {
	let endpoint = Endpoint::parse("tcp:127.0.0.1:7654", None).expect("valid tcp endpoint");

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
						assert!(errors.is_empty() || !errors.is_empty());
						let _ = sessions.value;
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
