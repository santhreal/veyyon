//! What one streamed delta costs a window that already holds a long session.
//!
//! Every host event batch runs three whole-session passes before a pixel
//! moves: the projection derives the shell state, the damage pass compares it
//! against the state the last frame drew, and the window retains a copy to
//! compare the next one against. Each is linear in the session, so the cost of
//! one token delta grows with how long the operator has been working.
//!
//! The corpus is one long session — `PRIOR_TURNS` exchanges, each with prose
//! and two tool invocations — and one streaming reply of `DELTAS` deltas. The
//! three phases are timed separately so the report states which pass the delta
//! is spent in rather than one number for the batch.

use std::{collections::HashMap, fmt::Write as _, hint::black_box, time::Instant};

use veyyon_desktop::{SessionIndex, project};
use veyyon_desktop_model::{
	ContentBlock, EntryId, HostEvent, MessageRole, SessionId, Store, StreamingMessageState,
	TranscriptEntry, reduce,
};
use veyyon_desktop_surface::{ShellState, damage::regions_changed};

const SESSION: &str = "bench-session";
/// Exchanges already in the transcript when the reply starts streaming.
const PRIOR_TURNS: usize = 120;
/// Streamed deltas in the reply, which is how many times the window
/// re-projects.
const DELTAS: usize = 48;
const WARMUP_RUNS: usize = 1;
const MEASURE_RUNS: usize = 5;

#[derive(Debug, Default, Clone, Copy)]
struct Batch {
	project: f64,
	compare: f64,
	retain:  f64,
}

fn entry(
	id: &str,
	role: MessageRole,
	content: Vec<ContentBlock>,
	revision: u64,
) -> TranscriptEntry {
	TranscriptEntry {
		id: EntryId::from(id),
		parent: None,
		revision,
		timestamp_ms: 1_000 + revision,
		role,
		content,
		meta: None,
		raw_discriminator: "text".to_string(),
		raw: serde_json::json!({}),
	}
}

fn text(body: &str) -> ContentBlock {
	ContentBlock::Text { text: body.to_string() }
}

/// One exchange: what the operator asked, and a reply that read two files.
fn exchange(turn: usize) -> Vec<TranscriptEntry> {
	let mut prose = String::with_capacity(512);
	for sentence in 0..6 {
		let _ = write!(
			prose,
			"The projection derives turn {turn} sentence {sentence} from the entries the host \
			 reported. "
		);
	}
	vec![
		entry(
			&format!("ask-{turn}"),
			MessageRole::User,
			vec![text(&format!("rewrite module {turn}"))],
			turn as u64,
		),
		entry(
			&format!("reply-{turn}"),
			MessageRole::Assistant,
			vec![
				text(&prose),
				ContentBlock::ToolCall {
					id:           format!("call-{turn}-a"),
					name:         "read".to_string(),
					arguments:    serde_json::json!({ "path": format!("crates/bench/src/m{turn}.rs") }),
					presentation: None,
				},
				ContentBlock::ToolResult {
					tool:         "read".to_string(),
					content:      serde_json::json!(prose),
					is_error:     false,
					presentation: None,
				},
				ContentBlock::ToolCall {
					id:           format!("call-{turn}-b"),
					name:         "edit".to_string(),
					arguments:    serde_json::json!({ "path": format!("crates/bench/src/m{turn}.rs") }),
					presentation: None,
				},
				ContentBlock::ToolResult {
					tool:         "edit".to_string(),
					content:      serde_json::json!("applied"),
					is_error:     false,
					presentation: None,
				},
			],
			turn as u64,
		),
	]
}

/// The store as a window holds it after `PRIOR_TURNS` exchanges.
fn seeded() -> Store {
	let mut store = Store::new();
	store.persisted.shell.active_session = Some(SessionId::from(SESSION));
	for turn in 0..PRIOR_TURNS {
		reduce(&mut store, HostEvent::TranscriptAppended {
			revision: turn as u64 + 1,
			entries:  exchange(turn),
		});
	}
	store
}

/// One streaming reply: each delta is a batch the window re-projects on.
fn corpus() -> Vec<HostEvent> {
	let mut body = String::new();
	(0..DELTAS)
		.map(|delta| {
			body.push_str("another sentence of the reply ");
			let revision = PRIOR_TURNS as u64 + 1 + delta as u64;
			HostEvent::StreamingChanged(Some(StreamingMessageState {
				entry: EntryId::from("reply"),
				tool: None,
				accumulating: entry("reply", MessageRole::Assistant, vec![text(&body)], revision),
				revision,
			}))
		})
		.collect()
}

/// Replays the reply, timing the three whole-session passes of each batch.
fn replay(events: &[HostEvent]) -> Vec<Batch> {
	let mut store = seeded();
	let mut index = SessionIndex::new();
	let mut state = ShellState::default();
	let mut drawn = ShellState::default();
	// The first projection is the one that has nothing to hold.
	project(&store, &mut index, &HashMap::new(), 10_000, &mut state);
	drawn.clone_from(&state);

	let mut samples = Vec::with_capacity(events.len());
	for (batch, event) in events.iter().enumerate() {
		reduce(&mut store, event.clone());
		let now_ms = 10_000 + batch as u64;

		let started = Instant::now();
		project(&store, &mut index, &HashMap::new(), now_ms, &mut state);
		let project_ms = started.elapsed().as_secs_f64() * 1_000.0;

		let started = Instant::now();
		let invalidation = regions_changed(&drawn, &state);
		let compare_ms = started.elapsed().as_secs_f64() * 1_000.0;

		let started = Instant::now();
		drawn.clone_from(&state);
		let retain_ms = started.elapsed().as_secs_f64() * 1_000.0;

		black_box(&invalidation);
		samples.push(Batch { project: project_ms, compare: compare_ms, retain: retain_ms });
	}
	samples
}

fn stats(runs: &[Vec<Batch>], phase: fn(&Batch) -> f64) -> (f64, f64, f64) {
	let mut all: Vec<f64> = runs.iter().flatten().map(phase).collect();
	all.sort_by(f64::total_cmp);
	let mean = all.iter().sum::<f64>() / all.len() as f64;
	(mean, all[all.len() / 2], all[(all.len() * 99) / 100])
}

fn main() {
	let events = corpus();
	println!(
		"corpus: {PRIOR_TURNS} prior exchanges ({} entries), {DELTAS} streamed deltas",
		PRIOR_TURNS * 2
	);

	for _ in 0..WARMUP_RUNS {
		let _ = replay(&events);
	}
	let runs: Vec<Vec<Batch>> = (0..MEASURE_RUNS).map(|_| replay(&events)).collect();

	println!("pass       mean/batch   p50      p99");
	let mut total = 0.0;
	for (name, phase) in [
		("project", (|b: &Batch| b.project) as fn(&Batch) -> f64),
		("compare", |b: &Batch| b.compare),
		("retain", |b: &Batch| b.retain),
	] {
		let (mean, p50, p99) = stats(&runs, phase);
		total += mean;
		println!("{name:10} {mean:8.3}ms {p50:8.3}ms {p99:8.3}ms");
	}
	println!("one streamed delta costs {total:.3}ms before a pixel moves");
}
