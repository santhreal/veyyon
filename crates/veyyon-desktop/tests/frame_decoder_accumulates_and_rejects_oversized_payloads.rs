use veyyon_desktop::{FrameDecoder, FramingError, MAX_FRAME_BYTES};
use veyyon_desktop_model::{ConnectionState, HostEvent, RequestId};

#[test]
fn frame_split_across_three_chunks_decodes_once() {
	let mut decoder = FrameDecoder::new();

	let part1 = b"{\"ConnectionChanged\":{\"Connected\":{\"endpoint\":";
	let part2 = b"\"tcp:127.0.0.1:7654\",";
	let part3 = b"\"protocol\":1}}}\n";

	let events1 = decoder
		.decode_chunk(part1)
		.expect("part 1 should accumulate");
	assert!(events1.is_empty(), "incomplete frame should yield no events");

	let events2 = decoder
		.decode_chunk(part2)
		.expect("part 2 should accumulate");
	assert!(events2.is_empty(), "incomplete frame should yield no events");

	let events3 = decoder.decode_chunk(part3).expect("part 3 completes frame");
	assert_eq!(events3.len(), 1);

	match &events3[0] {
		HostEvent::ConnectionChanged(ConnectionState::Connected { endpoint, protocol }) => {
			assert_eq!(endpoint, "tcp:127.0.0.1:7654");
			assert_eq!(*protocol, 1);
		},
		other => panic!("expected Connected event, got {other:?}"),
	}
}

#[test]
fn two_frames_in_one_chunk_decode_as_two() {
	let mut decoder = FrameDecoder::new();

	let chunk = b"{\"RequestSucceeded\":{\"request\":1}}\n{\"RequestSucceeded\":{\"request\":2}}\n";
	let events = decoder.decode_chunk(chunk).expect("chunk should decode");
	assert_eq!(events.len(), 2);

	match &events[0] {
		HostEvent::RequestSucceeded { request } => assert_eq!(*request, RequestId(1)),
		other => panic!("expected RequestSucceeded(1), got {other:?}"),
	}

	match &events[1] {
		HostEvent::RequestSucceeded { request } => assert_eq!(*request, RequestId(2)),
		other => panic!("expected RequestSucceeded(2), got {other:?}"),
	}
}

#[test]
fn empty_keep_alive_lines_are_skipped() {
	let mut decoder = FrameDecoder::new();

	let chunk = b"\n   \n\t\r\n{\"RequestSucceeded\":{\"request\":42}}\n\n  \n";
	let events = decoder
		.decode_chunk(chunk)
		.expect("keep-alives should be skipped");
	assert_eq!(events.len(), 1);

	match &events[0] {
		HostEvent::RequestSucceeded { request } => assert_eq!(*request, RequestId(42)),
		other => panic!("expected RequestSucceeded(42), got {other:?}"),
	}
}

#[test]
fn four_byte_utf8_sequence_split_across_chunk_boundary_survives() {
	let mut decoder = FrameDecoder::new();

	// 🦀 crab emoji is 4 bytes: 0xF0 0x9F 0xA6 0x80
	// We'll put it in a FatalProtocolError message
	let mut prefix = b"{\"FatalProtocolError\":{\"message\":\"Rust \xFA".to_vec();
	// replace invalid byte with crab start: 0xF0, 0x9F
	prefix.pop();
	prefix.extend_from_slice(&[0xf0, 0x9f]);

	let suffix = &[0xa6, 0x80, b'"', b'}', b'}', b'\n'];

	let events1 = decoder.decode_chunk(&prefix).expect("prefix chunk");
	assert!(events1.is_empty());

	let events2 = decoder.decode_chunk(suffix).expect("suffix chunk");
	assert_eq!(events2.len(), 1);

	match &events2[0] {
		HostEvent::FatalProtocolError { message } => {
			assert_eq!(message, "Rust 🦀");
		},
		other => panic!("expected FatalProtocolError with crab, got {other:?}"),
	}
}

#[test]
fn line_exceeding_max_frame_bytes_is_rejected_as_named_error() {
	let mut decoder = FrameDecoder::new();

	// Create oversized payload without newline
	let oversized_chunk = vec![b'a'; MAX_FRAME_BYTES + 1024];

	let res = decoder.decode_chunk(&oversized_chunk);
	match res {
		Err(FramingError::FrameTooLarge { max_bytes, actual_bytes }) => {
			assert_eq!(max_bytes, MAX_FRAME_BYTES);
			assert_eq!(actual_bytes, MAX_FRAME_BYTES + 1024);
		},
		other => panic!("expected FramingError::FrameTooLarge, got {other:?}"),
	}
}

#[test]
fn buffer_does_not_grow_past_cap_when_peer_sends_no_newline() {
	let mut decoder = FrameDecoder::new();

	let chunk_1mb = vec![b'x'; 1024 * 1024];
	let chunks_to_cap = MAX_FRAME_BYTES / chunk_1mb.len();

	// Feed exactly up to the cap
	for _ in 0..chunks_to_cap {
		let res = decoder.decode_chunk(&chunk_1mb);
		assert!(res.is_ok(), "up to the cap without newline should buffer");
	}
	assert_eq!(decoder.buffered_len(), MAX_FRAME_BYTES);

	// The next chunk must fail immediately without expanding the buffer past the
	// cap
	let res = decoder.decode_chunk(&chunk_1mb);
	assert!(matches!(res, Err(FramingError::FrameTooLarge { .. })));

	// Internal buffer did not grow to 9 MiB
	assert!(decoder.buffered_len() <= MAX_FRAME_BYTES);
}
