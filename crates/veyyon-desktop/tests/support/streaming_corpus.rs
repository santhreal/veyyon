//! The events a host sends while one assistant turn streams.
//!
//! Both arms of the damage suite replay this sequence, and a measurement is
//! comparable between them only when the corpus, the seed and the event
//! order are one definition rather than a copy per arm.

use veyyon_desktop_model::{
	ConnectionState, ContentBlock, EntryId, HostEvent, MessageRole, StreamingMessageState,
	TranscriptEntry,
};

pub const SEED: u64 = 0x5eed_cafe;
pub const DELTAS: usize = 48;
pub const PRIOR_ENTRIES: usize = 5;

const WORDS: [&str; 16] = [
	"the",
	"walker",
	"caches",
	"every",
	"entry",
	"it",
	"visits",
	"and",
	"prunes",
	"ignored",
	"directories",
	"before",
	"descending",
	"so",
	"a",
	"search",
];

/// One text entry at a revision.
pub fn entry(id: &str, role: MessageRole, text: &str, revision: u64) -> TranscriptEntry {
	TranscriptEntry {
		id: EntryId::from(id),
		parent: None,
		revision,
		timestamp_ms: 1_000 + revision,
		role,
		content: vec![ContentBlock::Text { text: text.to_string() }],
		meta: None,
		raw_discriminator: "text".to_string(),
		raw: serde_json::json!({}),
	}
}

/// One assistant turn streaming after five settled entries. Deterministic in
/// [`SEED`]; every arm of every suite replays exactly this sequence.
pub fn corpus() -> Vec<HostEvent> {
	let mut lcg = SEED;
	let mut next = move || {
		lcg = lcg
			.wrapping_mul(6_364_136_223_846_793_005)
			.wrapping_add(1_442_695_040_888_963_407);
		(lcg >> 33) as usize
	};

	let prior = (0..PRIOR_ENTRIES)
		.map(|index| {
			let role = if index % 2 == 0 {
				MessageRole::User
			} else {
				MessageRole::Assistant
			};
			let text = (0..12 + next() % 30)
				.map(|i| WORDS[(i + index) % WORDS.len()])
				.collect::<Vec<_>>();
			entry(&format!("prior-{index}"), role, &text.join(" "), index as u64 + 1)
		})
		.collect();

	let mut events = vec![
		HostEvent::ConnectionChanged(ConnectionState::Connected {
			endpoint: "bench".to_string(),
			protocol: 1,
		}),
		HostEvent::TranscriptAppended { revision: PRIOR_ENTRIES as u64, entries: prior },
	];

	let mut accumulated = String::new();
	for delta in 0..DELTAS {
		for _ in 0..=(next() % 4) {
			if !accumulated.is_empty() {
				accumulated.push(' ');
			}
			accumulated.push_str(WORDS[next() % WORDS.len()]);
		}
		let revision = PRIOR_ENTRIES as u64 + 1 + delta as u64;
		events.push(HostEvent::StreamingChanged(Some(StreamingMessageState {
			entry: EntryId::from("streaming"),
			tool: None,
			accumulating: entry("streaming", MessageRole::Assistant, &accumulated, revision),
			revision,
		})));
	}
	let final_revision = PRIOR_ENTRIES as u64 + 2 + DELTAS as u64;
	events.push(HostEvent::StreamingChanged(None));
	events.push(HostEvent::TranscriptAppended {
		revision: final_revision,
		entries:  vec![entry("streaming", MessageRole::Assistant, &accumulated, final_revision)],
	});
	events
}
