//! WHY THIS SUITE EXISTS
//!
//! The host sent every streaming frame as the whole accumulating reply, so a
//! reply cost the square of its length on the socket and in the window's
//! decoder. It now sends `StreamingAppended` with only the text a block grew
//! by, and the window rebuilds the reply from the last whole state it holds.
//!
//! THE CLASS THIS CLOSES: any path where the reply the window holds differs
//! from the one the host streamed: an append reduced to other text than the
//! whole state would have carried, an append lost or duplicated by the
//! coalescer's folding or its saturation handling, an append that does not
//! fit the held reply drawn instead of failing the connection, and a wire
//! spelling the host does not write.
//!
//! WHAT IT DOES NOT CATCH: whether the host's `appendedText` computes the
//! delta the Rust side expects;
//! `a-streamed-reply-reaches-the-window-once-a-frame.test.ts` pins the frames
//! the host writes, and this suite pins the bytes of one.

use veyyon_desktop_model::{
	ConnectionState, ContentBlock, Damage, EntryId, EventCoalescer, HostEvent, MessageRole,
	SessionId, Store, StreamingAppend, StreamingAppendError, StreamingMessageState, TranscriptEntry,
	reduce,
};

const SESSION: &str = "session-1";

fn store() -> Store {
	let mut store = Store::new();
	store.persisted.shell.active_session = Some(SessionId::from(SESSION));
	store
}

fn whole(entry: &str, revision: u64, content: Vec<ContentBlock>) -> HostEvent {
	HostEvent::StreamingChanged(Some(StreamingMessageState {
		entry: EntryId::from(entry),
		tool: None,
		accumulating: TranscriptEntry {
			id: EntryId::from(entry),
			parent: None,
			revision,
			timestamp_ms: 1_000,
			role: MessageRole::Assistant,
			content,
			meta: None,
			raw_discriminator: "assistant".to_string(),
			raw: serde_json::json!({}),
		},
		revision,
	}))
}

fn append(entry: &str, block: u32, text: &str, revision: u64) -> HostEvent {
	HostEvent::StreamingAppended(StreamingAppend {
		entry: EntryId::from(entry),
		block,
		text: text.to_string(),
		revision,
	})
}

fn text(text: &str) -> ContentBlock {
	ContentBlock::Text { text: text.to_string() }
}

fn thinking(text: &str) -> ContentBlock {
	ContentBlock::Thinking { text: text.to_string() }
}

/// What the window draws for the session: the held reply and the connection.
fn drawn(store: &Store) -> (Option<StreamingMessageState>, ConnectionState) {
	(store.streaming.get(&SessionId::from(SESSION)).cloned(), store.connection.clone())
}

fn reduce_all(events: Vec<HostEvent>) -> (Option<StreamingMessageState>, ConnectionState) {
	let mut store = store();
	for event in events {
		reduce(&mut store, event);
	}
	drawn(&store)
}

/// One reply, streamed: thinking that grows, a text block that starts (a
/// structural change the host sends whole), and text that grows.
fn reply() -> (Vec<HostEvent>, Vec<HostEvent>) {
	let whole_states = vec![
		whole("r", 1, vec![thinking("Let")]),
		whole("r", 2, vec![thinking("Let me")]),
		whole("r", 3, vec![thinking("Let me look")]),
		whole("r", 4, vec![thinking("Let me look"), text("It")]),
		whole("r", 5, vec![thinking("Let me look"), text("It is")]),
		whole("r", 6, vec![thinking("Let me look"), text("It is 42.")]),
	];
	let appended = vec![
		whole("r", 1, vec![thinking("Let")]),
		append("r", 0, " me", 2),
		append("r", 0, " look", 3),
		whole("r", 4, vec![thinking("Let me look"), text("It")]),
		append("r", 1, " is", 5),
		append("r", 1, " 42.", 6),
	];
	(whole_states, appended)
}

#[test]
fn appends_reduce_to_the_reply_the_whole_states_carry() {
	let (whole_states, appended) = reply();
	let mut by_whole = store();
	let mut by_append = store();
	for (step, (full, delta)) in whole_states.into_iter().zip(appended).enumerate() {
		reduce(&mut by_whole, full);
		let is_append = matches!(delta, HostEvent::StreamingAppended(_));
		let damage = reduce(&mut by_append, delta);
		assert_eq!(drawn(&by_append), drawn(&by_whole), "step {step}");
		if is_append {
			// An append changes the reply's text and nothing the run bar draws.
			assert_eq!(
				damage.iter().cloned().collect::<Vec<_>>(),
				vec![Damage::TranscriptEntry(SessionId::from(SESSION), EntryId::from("r"))],
				"step {step}"
			);
		}
	}
}

/// Every way an append can fail to fit, named by the error it raises. The
/// match is exhaustive, so a new error variant fails to compile here until a
/// case below raises it.
const fn error_name(error: &StreamingAppendError) -> &'static str {
	match error {
		StreamingAppendError::NoStream { .. } => "no stream",
		StreamingAppendError::OtherEntry { .. } => "other entry",
		StreamingAppendError::NoBlock { .. } => "no block",
		StreamingAppendError::NotText { .. } => "not text",
	}
}

#[test]
fn an_append_that_does_not_fit_the_held_reply_fails_the_connection() {
	let held =
		|| whole("r", 1, vec![text("It"), ContentBlock::RedactedThinking { marker: "m".into() }]);
	let cases = [
		("no stream", None, append("r", 0, "x", 2)),
		("other entry", Some(held()), append("q", 0, "x", 2)),
		("no block", Some(held()), append("r", 2, "x", 2)),
		("not text", Some(held()), append("r", 1, "x", 2)),
	];
	let mut raised = Vec::new();
	for (name, base, bad) in cases {
		let mut store = store();
		if let Some(base) = base {
			reduce(&mut store, base);
		}
		let before = store.streaming.clone();
		let HostEvent::StreamingAppended(sent) = &bad else {
			unreachable!("every case is an append")
		};
		let error = match store.streaming.get(&SessionId::from(SESSION)).cloned() {
			Some(mut state) => state.append(sent).expect_err(name),
			None => StreamingAppendError::NoStream { entry: sent.entry.clone() },
		};
		assert_eq!(error_name(&error), name);
		raised.push(error_name(&error));

		let damage = reduce(&mut store, bad);
		assert_eq!(store.streaming, before, "{name}: the held reply is left as it was");
		assert_eq!(
			store.connection,
			ConnectionState::Fatal { message: error.to_string() },
			"{name}: the connection states the mismatch"
		);
		assert!(damage.contains(&Damage::FullWindow), "{name}");
	}
	assert_eq!(raised, ["no stream", "other entry", "no block", "not text"]);
}

#[test]
fn folding_a_batch_changes_nothing_it_reduces_to() {
	let (_, appended) = reply();
	let batches: Vec<(&str, Vec<HostEvent>, usize)> = vec![
		("a whole state and its appends", appended[..3].to_vec(), 1),
		("a structural change inside the batch", appended.clone(), 1),
		("appends with the base already held", appended[4..].to_vec(), 1),
		(
			"a new reply after the old one ends",
			{
				let mut events = appended[..3].to_vec();
				events.push(HostEvent::StreamingChanged(None));
				events.push(whole("s", 7, vec![text("New")]));
				events.push(append("s", 0, " reply", 8));
				events
			},
			3,
		),
		(
			"an append that does not fit stays its own event",
			vec![whole("r", 1, vec![text("It")]), append("r", 3, "x", 2)],
			2,
		),
	];
	for (name, events, folded_len) in batches {
		// The base the append-only batch grows is held before it arrives.
		let prefix = if name.starts_with("appends with") {
			appended[..4].to_vec()
		} else {
			Vec::new()
		};
		let folded = EventCoalescer::fold(events.clone());
		assert_eq!(folded.len(), folded_len, "{name}: {folded:?}");
		assert_eq!(
			reduce_all(prefix.iter().cloned().chain(folded).collect()),
			reduce_all(prefix.into_iter().chain(events).collect()),
			"{name}"
		);
	}
}

#[test]
fn a_saturated_queue_folds_its_appends_instead_of_dropping_text() {
	let mut coalescer = EventCoalescer::new(4);
	coalescer
		.push(whole("r", 1, vec![text("0")]))
		.expect("an empty queue takes an event");
	let mut expected = String::from("0");
	for n in 1..=64u64 {
		let delta = format!(" {n}");
		expected.push_str(&delta);
		coalescer
			.push(append("r", 0, &delta, n + 1))
			.expect("a saturated queue folds and takes it");
		assert!(coalescer.len() <= 4, "the queue stays within its capacity");
	}
	let (reply, connection) = reduce_all(coalescer.drain_frame());
	let reply = reply.expect("the reply is held");
	assert_eq!(reply.accumulating.content, vec![text(&expected)]);
	assert_eq!(reply.revision, 65);
	assert!(!matches!(connection, ConnectionState::Fatal { .. }));
}

#[test]
fn an_append_decodes_from_the_bytes_the_host_writes() {
	let frame = r#"{"StreamingAppended":{"entry":"stream-1","block":0,"text":" two","revision":1}}"#;
	let event: HostEvent = serde_json::from_str(frame).expect("the host's append frame decodes");
	assert_eq!(event, append("stream-1", 0, " two", 1));
	assert_eq!(serde_json::to_string(&event).expect("encodes"), frame);
}
