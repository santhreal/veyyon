use veyyon_desktop_model::{
	ContentBlock, Damage, EntryId, EventCoalescer, HostEvent, MessageRole, SessionId, Store,
	StreamingMessageState, TranscriptEntry, reduce,
};

#[test]
fn test_coalescer_folds_60_streaming_events_into_single_damage() {
	let mut coalescer = EventCoalescer::new(4096);
	let session_id = SessionId::from("session-fold-test");

	// Generate 60 rapid streaming chunk updates
	for rev in 1..=60 {
		let entry = TranscriptEntry {
			id:                EntryId::from("stream-entry"),
			parent:            None,
			revision:          rev,
			timestamp_ms:      1000 + rev,
			role:              MessageRole::Assistant,
			content:           vec![ContentBlock::Text {
				text: format!("Accumulated token count: {rev}"),
			}],
			meta:              None,
			raw_discriminator: "text".to_string(),
			raw:               serde_json::json!({}),
		};

		let stream_state = StreamingMessageState {
			entry:        EntryId::from("stream-entry"),
			tool:         None,
			accumulating: entry,
			revision:     rev,
		};

		let push_result = coalescer.push(HostEvent::StreamingChanged(Some(stream_state)));
		assert!(push_result.is_ok());
	}

	assert_eq!(coalescer.len(), 60);

	// Drain frame - must collapse 60 events down to 1 event
	let drained = coalescer.drain_frame();
	assert_eq!(drained.len(), 1);

	// Verify the folded event holds the final revision (60)
	if let HostEvent::StreamingChanged(Some(final_stream)) = &drained[0] {
		assert_eq!(final_stream.revision, 60);
		if let ContentBlock::Text { text } = &final_stream.accumulating.content[0] {
			assert_eq!(text, "Accumulated token count: 60");
		} else {
			panic!("Unexpected content block type");
		}
	} else {
		panic!("Expected StreamingChanged event");
	}

	// Reduce folded event against store
	let mut store = Store::new();
	store.persisted.shell.active_session = Some(session_id.clone());
	let damage = reduce(&mut store, drained[0].clone());

	// Must produce exactly one TranscriptEntry damage and one RunBar damage
	assert_eq!(damage.len(), 2);
	assert!(
		damage.contains(&Damage::TranscriptEntry(session_id.clone(), EntryId::from("stream-entry")))
	);
	assert!(damage.contains(&Damage::RunBar(session_id)));
}

#[test]
fn test_coalescer_fold_is_pure() {
	let mut events = Vec::new();
	for rev in 1..=20 {
		let entry = TranscriptEntry {
			id:                EntryId::from("entry-pure"),
			parent:            None,
			revision:          rev,
			timestamp_ms:      1000 + rev,
			role:              MessageRole::Assistant,
			content:           vec![ContentBlock::Text { text: format!("Token {rev}") }],
			meta:              None,
			raw_discriminator: "text".to_string(),
			raw:               serde_json::json!({}),
		};

		events.push(HostEvent::StreamingChanged(Some(StreamingMessageState {
			entry:        EntryId::from("entry-pure"),
			tool:         None,
			accumulating: entry,
			revision:     rev,
		})));
	}

	let fold_1 = EventCoalescer::fold(events.clone());
	let fold_2 = EventCoalescer::fold(events.clone());
	let fold_3 = EventCoalescer::fold(events);

	assert_eq!(fold_1, fold_2);
	assert_eq!(fold_2, fold_3);
	assert_eq!(fold_1.len(), 1);
}
