//! What one streamed batch costs the projection when the workspace panel is
//! holding a repository's diff and an open file.
//!
//! Every host event batch re-projects the whole window, so whatever the panel
//! derives is derived again for each streamed delta of a turn. The two arms
//! replay one streaming turn over the same store: `Held` re-projects against
//! the panel content the window already has, `Rederived` re-projects against a
//! fresh one, which is what a projection that reuses nothing does. The corpus,
//! the store and the deltas are identical, so the difference is the derivation.

use std::{collections::HashMap, fmt::Write as _, hint::black_box, time::Instant};

use veyyon_desktop::{SessionIndex, project};
use veyyon_desktop_model::{
	ChangeScope, ChangeStatus, ChangedFile, ChangesView, ContentBlock, EntryId, FileContentView,
	HostEvent, MessageRole, SessionId, SnapshotSection, Store, StreamingMessageState,
	TranscriptEntry, reduce,
};
use veyyon_desktop_surface::ShellState;

const SESSION: &str = "bench-session";
/// Changed files in the working tree the panel is drawing.
const FILES: usize = 40;
/// Changed lines in each of them.
const LINES_PER_FILE: usize = 400;
/// Lines in the file the File tab is holding.
const OPEN_FILE_LINES: usize = 4_000;
/// Streamed deltas in the turn, which is how many times the window re-projects.
const DELTAS: usize = 48;
const WARMUP_RUNS: usize = 1;
const MEASURE_RUNS: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Arm {
	Held,
	Rederived,
}

fn entry(id: &str, text: &str, revision: u64) -> TranscriptEntry {
	TranscriptEntry {
		id: EntryId::from(id),
		parent: None,
		revision,
		timestamp_ms: 1_000 + revision,
		role: MessageRole::Assistant,
		content: vec![ContentBlock::Text { text: text.to_string() }],
		meta: None,
		raw_discriminator: "text".to_string(),
		raw: serde_json::json!({}),
	}
}

/// A unified diff of `FILES` files, each replacing `LINES_PER_FILE` lines.
fn changes() -> ChangesView {
	let mut diff = String::new();
	let mut files = Vec::with_capacity(FILES);
	for file in 0..FILES {
		let path = format!("crates/bench/src/module_{file:02}.rs");
		let _ = write!(diff, "diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n");
		let _ = writeln!(diff, "@@ -1,{LINES_PER_FILE} +1,{LINES_PER_FILE} @@");
		for line in 0..LINES_PER_FILE {
			let _ = writeln!(diff, "-const ENTRY_{line:04}: u32 = {line};");
		}
		for line in 0..LINES_PER_FILE {
			let _ = writeln!(diff, "+const ENTRY_{line:04}: u32 = {};", line * 100);
		}
		files.push(ChangedFile {
			path,
			previous_path: None,
			status: ChangeStatus::Modified,
			additions: LINES_PER_FILE as u64,
			deletions: LINES_PER_FILE as u64,
		});
	}
	ChangesView {
		revision: 1,
		repository: Some("/workspace".to_string()),
		scope: ChangeScope::WorkingTree,
		files,
		diff,
	}
}

fn open_file() -> FileContentView {
	let mut content = String::new();
	for line in 0..OPEN_FILE_LINES {
		let _ = writeln!(content, "fn item_{line:04}() -> u32 {{ {line} }}");
	}
	FileContentView {
		size_bytes: content.len() as u64,
		path: "crates/bench/src/lib.rs".to_string(),
		content,
		truncated: false,
		binary: false,
	}
}

/// The store as a window holds it once the panel has been sent a repository's
/// diff and a file, with one prompt already in the transcript.
fn seeded() -> Store {
	let mut store = Store::new();
	store.persisted.shell.active_session = Some(SessionId::from(SESSION));
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Changes(changes())));
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::FileContent(open_file())));
	reduce(&mut store, HostEvent::TranscriptAppended {
		revision: 1,
		entries:  vec![entry("prompt", "rewrite every module", 1)],
	});
	store
}

/// One streaming turn: each delta is a batch the window re-projects on.
fn corpus() -> Vec<HostEvent> {
	let mut text = String::new();
	(0..DELTAS)
		.map(|delta| {
			text.push_str("another sentence of the reply ");
			let revision = 2 + delta as u64;
			HostEvent::StreamingChanged(Some(StreamingMessageState {
				entry: EntryId::from("reply"),
				tool: None,
				accumulating: entry("reply", &text, revision),
				revision,
			}))
		})
		.collect()
}

fn replay(arm: Arm, events: &[HostEvent]) -> Vec<f64> {
	let mut store = seeded();
	let mut index = SessionIndex::new();
	let mut state = ShellState::default();
	// The first projection is the one that has nothing to hold, in both arms.
	project(&store, &mut index, &HashMap::new(), 10_000, &mut state);

	let mut samples = Vec::with_capacity(events.len());
	for (batch, event) in events.iter().enumerate() {
		reduce(&mut store, event.clone());
		if arm == Arm::Rederived {
			state.panel = veyyon_desktop_surface::PanelContent::default();
		}
		let started = Instant::now();
		project(&store, &mut index, &HashMap::new(), 10_000 + batch as u64, &mut state);
		samples.push(started.elapsed().as_secs_f64() * 1_000.0);
		black_box(&state.panel);
	}
	samples
}

fn stats(runs: &[Vec<f64>]) -> (f64, f64, f64) {
	let mut all: Vec<f64> = runs.iter().flatten().copied().collect();
	all.sort_by(f64::total_cmp);
	let total: f64 = all.iter().sum();
	let mean = total / all.len() as f64;
	let p50 = all[all.len() / 2];
	let p99 = all[(all.len() * 99) / 100];
	(mean, p50, p99)
}

fn main() {
	let events = corpus();
	let diff_bytes = changes().diff.len();
	println!(
		"corpus: {FILES} changed files, {LINES_PER_FILE} lines each ({diff_bytes} bytes of unified \
		 diff), one open file of {OPEN_FILE_LINES} lines, {DELTAS} streamed deltas"
	);

	for _ in 0..WARMUP_RUNS {
		let _ = replay(Arm::Held, &events);
		let _ = replay(Arm::Rederived, &events);
	}

	let mut held = Vec::with_capacity(MEASURE_RUNS);
	let mut rederived = Vec::with_capacity(MEASURE_RUNS);
	for _ in 0..MEASURE_RUNS {
		held.push(replay(Arm::Held, &events));
		rederived.push(replay(Arm::Rederived, &events));
	}

	let (held_mean, held_p50, held_p99) = stats(&held);
	let (re_mean, re_p50, re_p99) = stats(&rederived);
	println!("arm        mean/batch   p50      p99");
	println!("held       {held_mean:8.3}ms {held_p50:8.3}ms {held_p99:8.3}ms");
	println!("rederived  {re_mean:8.3}ms {re_p50:8.3}ms {re_p99:8.3}ms");
	println!(
		"one streamed delta costs {:.3}ms more when the panel derives again ({:.1}x)",
		re_mean - held_mean,
		re_mean / held_mean
	);
}
