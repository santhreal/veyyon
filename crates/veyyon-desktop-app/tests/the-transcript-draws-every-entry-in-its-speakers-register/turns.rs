//! The transcript lists the active branch as turns, a prompt and everything
//! that came back, and draws each entry as the pieces its blocks state.
//!
//! WHY: the window reads the store's tree into one branch and cuts it into
//! turns before any piece is drawn, so a result drawn apart from its call, a
//! reopened transcript listed twice, an abandoned branch listed, a mode read
//! as the identifier it was recorded under, a pane drawn past its ceiling or
//! a turn footed by a model the host never stated reaches the column as it
//! is. Each test drives host events into the real window and reads the
//! branch it lists, the turns its index cuts, the plan each item is drawn
//! from and the words the frame painted.
//!
//! Gap: the sweep over every block kind is `kinds`; a streamed reply's
//! scrolling is `a-streamed-reply-scrolls-as-the-transcripts-last-item`; an
//! output pane's lines past its scroll height are read from the plan, not
//! the frame.

use std::ops::Range;

use gpui::TestAppContext;
use strum::IntoEnumIterator as _;
use veyyon_desktop_app::transcript::{plan::Piece, turn::TurnIndex, values::PANE_LINE_CEILING};
use veyyon_desktop_model::{
	ContentBlock, EntryId, EntryMeta, HostEvent, MessageRole, StreamingMessageState, TranscriptEntry,
};

use super::{
	Thread, chain, entry,
	items::{Side, click_run, drawn_by, form, forms, laid_out, side_of},
	opened, sid, snapshot, text, thread,
};

/// The display ranges the window cuts its branch into, one per turn.
fn turns(thread: &Thread<'_>) -> Vec<Range<usize>> {
	thread.state.read_with(&*thread.cx, |state, _| {
		let mut index = TurnIndex::default();
		index.rebuild(state, &sid());
		let mut ranges: Vec<Range<usize>> = (0..state.entry_count(&sid()))
			.filter_map(|ix| index.turn_at(ix).map(|turn| turn.range.clone()))
			.collect();
		ranges.dedup();
		ranges
	})
}

#[gpui::test]
fn a_turn_is_a_prompt_and_everything_that_came_back_with_a_result_drawn_in_its_calls_row(
	cx: &mut TestAppContext,
) {
	let call = ContentBlock::ToolCall {
		id:           "c".to_owned(),
		name:         "read".to_owned(),
		arguments:    serde_json::json!({ "path": "src/lib.rs" }),
		presentation: None,
	};
	let result = ContentBlock::ToolResult {
		tool:         "c".to_owned(),
		content:      serde_json::json!("12 lines\nmore"),
		is_error:     false,
		presentation: None,
	};
	let mut thread = thread(
		cx,
		opened(chain(vec![
			("u1", MessageRole::User, vec![text("do it")]),
			("a1", MessageRole::Assistant, vec![text("reading"), call]),
			("t1", MessageRole::ToolResult, vec![result]),
			("a2", MessageRole::Assistant, vec![text("done")]),
			("u2", MessageRole::User, vec![text("and then")]),
		])),
	);

	assert_eq!(turns(&thread), [0..4, 4..5], "a turn is not a prompt and what came back");
	let planned: Vec<Vec<String>> = (0..5).map(|ix| forms(&mut thread, ix)).collect();
	assert_eq!(
		planned,
		[
			vec!["bubble: do it".to_owned()],
			vec![
				"prose #0".to_owned(),
				"worked from 0: Worked for 0s · 1 step (open)".to_owned(),
				"tool c Success: Read src/lib.rs".to_owned(),
			],
			Vec::new(),
			vec!["prose #0".to_owned()],
			vec!["bubble: and then".to_owned()],
		],
		"the turn is not planned as its prompt, its reply and one answered call"
	);

	click_run(&mut thread, "▸ Worked for 0s · 1 step");
	click_run(&mut thread, "Read");
	assert_eq!(
		drawn_by(&mut thread, "a1"),
		["reading", "▾ Worked for 0s · 1 step", "✓", "Read", "src/lib.rs", "0s", "12 lines", "more"],
		"the result is not drawn inside the row of the call it answered"
	);
	assert_eq!(
		laid_out(&mut thread, "transcript.entry:t1"),
		None,
		"the answered result drew an item"
	);
}

#[gpui::test]
fn an_entry_of_every_role_holding_nothing_links_the_branch_and_draws_no_item(
	cx: &mut TestAppContext,
) {
	let mut broke = Vec::new();
	for role in MessageRole::iter() {
		let mut thread = thread(
			cx,
			opened(chain(vec![
				("hidden", role, Vec::new()),
				("visible", MessageRole::User, vec![text("A visible prompt")]),
			])),
		);
		let ids = thread.ids();
		let hidden = forms(&mut thread, 0);
		let item = laid_out(&mut thread, "transcript.entry:hidden");
		let shown = forms(&mut thread, 1);
		let side = side_of(&mut thread, "visible");
		if ids != ["hidden", "visible"]
			|| !hidden.is_empty()
			|| item.is_some()
			|| shown != ["bubble: A visible prompt"]
			|| side != Some(Side::Operator)
		{
			broke.push(format!(
				"{role:?} listed {ids:?}, planned {hidden:?} and was laid out at {item:?}; the prompt \
				 after it planned {shown:?} on {side:?}"
			));
		}
	}
	assert_eq!(broke, Vec::<String>::new(), "an entry holding nothing drew or cut the branch");
}

#[gpui::test]
fn a_mode_note_states_the_mode_in_words_whatever_the_record_spells_it(cx: &mut TestAppContext) {
	// The spellings the host writes, and one it may write later: the reading
	// is total, so a mode added over there reads as words here.
	let stated = [
		("none", "off"),
		("plan", "plan"),
		("plan_paused", "plan paused"),
		("goal", "goal"),
		("goal_paused", "goal paused"),
		("loop", "loop"),
		("vibe", "vibe"),
		("a_mode-this_window-has_not-been_taught", "a mode this window has not been taught"),
	];
	let mut thread = thread(cx, opened(Vec::new()));
	let mut broke = Vec::new();
	for (revision, (recorded, words)) in (2..).zip(stated) {
		let id = format!("m{revision}");
		let mode = ContentBlock::ModeChange { mode: recorded.to_owned() };
		thread.apply(vec![snapshot(revision, vec![entry(&id, None, MessageRole::Assistant, vec![
			mode,
		])])]);
		let planned = forms(&mut thread, 0);
		let drew = drawn_by(&mut thread, &id);
		if planned != [format!("note Mode: {words}")] || drew != ["Mode", words] {
			broke.push(format!("`{recorded}` planned {planned:?} and drew {drew:?}"));
		}
	}
	assert_eq!(broke, Vec::<String>::new(), "a recorded mode did not read as words");
}

#[gpui::test]
fn the_branch_is_read_from_the_leaf_and_a_streamed_reply_draws_after_it(cx: &mut TestAppContext) {
	let mut thread = thread(
		cx,
		opened(vec![
			entry("u1", None, MessageRole::User, vec![text("which way")]),
			entry("a-old", Some("u1"), MessageRole::Assistant, vec![text("abandoned branch")]),
			entry("a-new", Some("u1"), MessageRole::Assistant, vec![text("kept branch")]),
		]),
	);
	assert_eq!(thread.ids(), ["u1", "a-new"], "the branch is not the one the leaf ends");
	assert!(!thread.drew("abandoned branch"), "the abandoned branch is drawn");

	thread.apply(vec![HostEvent::StreamingChanged(Some(StreamingMessageState {
		entry:        EntryId::from("stream-1"),
		tool:         None,
		accumulating: entry("stream-1", None, MessageRole::Assistant, vec![text("partial")]),
		revision:     2,
	}))]);
	let top = |thread: &mut Thread<'_>, words: &str| {
		thread
			.runs()
			.into_iter()
			.find(|(run, _)| run == words)
			.map(|(_, bounds)| f32::from(bounds.origin.y))
	};
	let (kept, partial) = (top(&mut thread, "kept branch"), top(&mut thread, "partial"));
	assert!(
		matches!((kept, partial), (Some(kept), Some(partial)) if partial > kept),
		"the streamed reply is not drawn after the branch: kept at {kept:?}, partial at {partial:?}"
	);
}

#[gpui::test]
fn a_transcript_sent_whole_again_replaces_the_one_loaded_before(cx: &mut TestAppContext) {
	let prompts = |ids: &[&str]| -> Vec<TranscriptEntry> {
		ids.iter()
			.map(|id| entry(id, None, MessageRole::User, vec![text(&format!("prompt {id}"))]))
			.collect()
	};
	let mut thread = thread(cx, opened(prompts(&["a", "b", "c"])));
	assert_eq!(thread.ids(), ["a", "b", "c"], "the first transcript is not listed");

	thread.apply(vec![snapshot(2, prompts(&["d"]))]);
	assert_eq!(thread.ids(), ["d"], "the reopened transcript did not replace the first");
	assert_eq!(
		["prompt a", "prompt b", "prompt c", "prompt d"].map(|words| thread.drew_times(words)),
		[0, 0, 0, 1],
		"the reopened transcript is not drawn once, alone"
	);
}

#[gpui::test]
fn a_pane_holds_its_ceiling_and_counts_the_lines_past_it(cx: &mut TestAppContext) {
	let mut thread = thread(cx, opened(Vec::new()));
	let mut broke = Vec::new();
	for (revision, (printed, rest)) in (2..).zip([
		(PANE_LINE_CEILING - 1, None),
		(PANE_LINE_CEILING, None),
		(PANE_LINE_CEILING + 1, Some("… 1 more line")),
		(PANE_LINE_CEILING + 5, Some("… 5 more lines")),
	]) {
		let id = format!("x{revision}");
		let output = (0..printed)
			.map(|n| format!("line {n}"))
			.collect::<Vec<_>>()
			.join("\n");
		let run = ContentBlock::Execution {
			language: "bash".to_owned(),
			command: Some("seq".to_owned()),
			output,
			exit_code: Some(2),
		};
		thread.apply(vec![snapshot(revision, vec![entry(
			&id,
			None,
			MessageRole::BashExecution,
			vec![run],
		)])]);
		let held = printed.min(PANE_LINE_CEILING);
		let expected: Vec<String> = (0..held)
			.map(|n| format!("line {n}"))
			.chain(rest.map(str::to_owned))
			.collect();
		let plan = thread.plan(0);
		let lines = match plan.pieces.as_slice() {
			[Piece::Pane { caption, lines, diff: false }] if caption == "Shell: seq · exit 2" => {
				lines
			},
			pieces => {
				let forms: Vec<String> = pieces.iter().map(form).collect();
				broke.push(format!("{printed} lines planned {forms:?}"));
				continue;
			},
		};
		if *lines != expected || !thread.drew("Shell: seq · exit 2") {
			broke.push(format!(
				"{printed} lines planned {} lines ending {:?}",
				lines.len(),
				lines.last()
			));
		}
	}
	assert_eq!(
		broke,
		Vec::<String>::new(),
		"a pane is not held to its ceiling with the rest counted"
	);
}

/// `entry` as reported by `model`.
pub fn named(mut entry: TranscriptEntry, model: &str) -> TranscriptEntry {
	entry.meta = Some(EntryMeta {
		provider:    Some("anthropic".to_owned()),
		model:       Some(model.to_owned()),
		stop_reason: None,
		error:       None,
		usage:       None,
	});
	entry
}

#[gpui::test]
fn a_finished_turn_is_footed_by_the_model_its_last_entry_reported_and_by_none_without_one(
	cx: &mut TestAppContext,
) {
	let mut thread = thread(
		cx,
		opened(vec![
			entry("u1", None, MessageRole::User, vec![text("do it")]),
			named(
				entry("a1", Some("u1"), MessageRole::Assistant, vec![text("reading")]),
				"claude-sonnet-4-6",
			),
			named(
				entry("a2", Some("a1"), MessageRole::Assistant, vec![text("done")]),
				"claude-opus-4-1",
			),
			entry("u2", Some("a2"), MessageRole::User, vec![text("again")]),
			entry("a3", Some("u2"), MessageRole::Assistant, vec![text("once more")]),
		]),
	);
	let planned = [1, 2, 4].map(|ix| forms(&mut thread, ix));
	assert_eq!(
		planned,
		[
			vec!["prose #0".to_owned()],
			vec!["prose #0".to_owned(), "footer: claude-opus-4-1".to_owned()],
			vec!["prose #0".to_owned()],
		],
		"a turn is not footed by the model its last entry reported, or is footed without one"
	);
	assert_eq!(
		["claude-opus-4-1", "claude-sonnet-4-6"].map(|model| thread.drew_times(model)),
		[1, 0],
		"the footer drew a model other than the last one reported"
	);
}
