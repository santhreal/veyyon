use veyyon_desktop_model::{
	ContentBlock, Damage, DamageSet, EntryId, EventCoalescer, HostActionKind, HostEvent,
	MessageRole, QueuePartition, RequestId, RequestRegistry, SessionId, StreamingMessageState,
	SurfaceId, TranscriptEntry,
};

#[test]
fn test_registry_eviction_bound_and_termination() {
	let mut registry = RequestRegistry::new();
	let start_time = 10_000;

	// Insert 2000 requests (exceeding the 1024 capacity limit)
	for i in 1..=2000 {
		registry.register(
			RequestId(i),
			HostActionKind::SubmitPrompt,
			SurfaceId::GlobalTitlebarLine,
			start_time,
			30_000, // 30s timeout
		);
	}

	// 1. Bound assertion: capacity must never exceed 1024
	assert_eq!(registry.len(), 1024, "Registry exceeded maximum 1024 in-flight bound");

	// 2. Timeout termination assertion: after 31s, all entries must be evicted
	let pruned = registry.prune_stale(start_time + 31_000);
	assert_eq!(pruned.len(), 1024, "Expected all 1024 items to be pruned on timeout");
	assert!(registry.is_empty(), "Registry must be completely empty after timeout pruning");
}

#[test]
fn test_damage_coarsening_bounds_and_hierarchy() {
	let mut damage_set = DamageSet::new();

	// 1. QueueRow coarsening: > 16 QueueRow damages collapse to QueueAll
	for i in 1..=20 {
		damage_set.insert(Damage::QueueRow(SessionId::from(format!("session-{i}"))));
	}
	assert!(damage_set.contains(&Damage::QueueAll), "Expected QueueAll after > 16 QueueRow items");
	assert_eq!(
		damage_set
			.iter()
			.filter(|d| matches!(d, Damage::QueueRow(_) | Damage::QueuePartition(_)))
			.count(),
		0,
		"All QueueRow items must be subsumed by QueueAll"
	);

	// 2. TranscriptEntry coarsening: > 32 entries for a session collapse to
	//    TranscriptFull
	let mut transcript_damage = DamageSet::new();
	let session = SessionId::from("heavy-session");
	for i in 1..=35 {
		transcript_damage
			.insert(Damage::TranscriptEntry(session.clone(), EntryId::from(format!("entry-{i}"))));
	}
	assert!(
		transcript_damage.contains(&Damage::TranscriptFull(session.clone())),
		"Expected TranscriptFull after > 32 TranscriptEntry items for a session"
	);
	assert_eq!(
		transcript_damage
			.iter()
			.filter(|d| matches!(d, Damage::TranscriptEntry(s, _) if s == &session))
			.count(),
		0,
		"All TranscriptEntry items must be subsumed by TranscriptFull"
	);

	// 3. Aggregate item count bound: > 64 unique damages collapse to FullWindow
	let mut large_set = DamageSet::new();
	for i in 1..=70 {
		large_set.insert(Damage::RightPanelTab(SessionId::from("s1"), format!("tab-{i}")));
	}
	assert_eq!(
		large_set.len(),
		1,
		"Damage set exceeding 64 items must coarsen to single FullWindow"
	);
	assert!(large_set.contains(&Damage::FullWindow), "Must contain FullWindow");

	// 4. FullWindow subsumption
	let mut mixed_set = DamageSet::new();
	mixed_set.insert(Damage::Titlebar);
	mixed_set.insert(Damage::ConnectionLine);
	mixed_set.insert(Damage::QueuePartition(QueuePartition::Live));
	mixed_set.insert(Damage::FullWindow);
	assert_eq!(mixed_set.len(), 1);
	assert!(mixed_set.contains(&Damage::FullWindow));
}

#[test]
fn test_coalescer_queue_bound_and_drop_priority() {
	let mut coalescer = EventCoalescer::new(100);

	// 1. Fill queue with 50 connection events and 50 streaming events
	for i in 1..=50 {
		let conn_event =
			HostEvent::ConnectionChanged(veyyon_desktop_model::ConnectionState::Connecting {
				attempt: i,
			});
		assert!(coalescer.push(conn_event).is_ok());
	}

	for i in 1..=50 {
		let stream_event = HostEvent::StreamingChanged(Some(StreamingMessageState {
			entry:        EntryId::from("stream"),
			tool:         None,
			accumulating: TranscriptEntry {
				id:                EntryId::from("stream"),
				parent:            None,
				revision:          i as u64,
				timestamp_ms:      1000,
				role:              MessageRole::Assistant,
				content:           vec![ContentBlock::Text { text: "chunk".to_string() }],
				meta:              None,
				raw_discriminator: "text".to_string(),
				raw:               serde_json::json!({}),
			},
			revision:     i as u64,
		}));
		assert!(coalescer.push(stream_event).is_ok());
	}

	assert_eq!(coalescer.len(), 100);

	// 2. Push 20 more events; intermediate streaming events must drop first without
	//    exceeding capacity 100
	for i in 51..=70 {
		let stream_event = HostEvent::StreamingChanged(Some(StreamingMessageState {
			entry:        EntryId::from("stream"),
			tool:         None,
			accumulating: TranscriptEntry {
				id:                EntryId::from("stream"),
				parent:            None,
				revision:          i as u64,
				timestamp_ms:      1000,
				role:              MessageRole::Assistant,
				content:           vec![ContentBlock::Text { text: "overflow chunk".to_string() }],
				meta:              None,
				raw_discriminator: "text".to_string(),
				raw:               serde_json::json!({}),
			},
			revision:     i as u64,
		}));
		let push_res = coalescer.push(stream_event);
		assert!(push_res.is_ok());
		assert!(coalescer.len() <= 100, "Coalescer queue exceeded configured capacity bound");
	}

	// Drain frame and verify finite termination
	let drained = coalescer.drain_frame();
	assert!(!drained.is_empty(), "Drained frame must contain folded events");
	assert!(coalescer.is_empty());
}
