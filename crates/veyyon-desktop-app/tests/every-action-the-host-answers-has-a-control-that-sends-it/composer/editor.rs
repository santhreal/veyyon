//! Gestures on the composer: text typed into its editor and the keys it
//! holds, the chips of its footer and the pickers they open, the strips
//! above its frame, and the palette rows that act on its draft.

use serde_json::json;
use veyyon_desktop_model::{
	ContentBlock, EntryId, HostEvent, MessageRole, SnapshotSectionKind, StreamingMessageState,
	TranscriptEntry,
};

use super::click_text_in;
use crate::harness::{Win, corpus, section};

/// A reply streaming into `sess-1`: its turn runs.
fn running() -> HostEvent {
	let reply = TranscriptEntry {
		id:                EntryId::from("stream-1"),
		parent:            None,
		revision:          2,
		timestamp_ms:      1_600_000_000_001,
		role:              MessageRole::Assistant,
		content:           vec![ContentBlock::Text { text: "Reading the repo".to_owned() }],
		meta:              None,
		raw_discriminator: String::new(),
		raw:               serde_json::Value::Null,
	};
	HostEvent::StreamingChanged(Some(StreamingMessageState {
		entry:        EntryId::from("stream-1"),
		tool:         None,
		accumulating: reply,
		revision:     2,
	}))
}

/// Two models of one provider, the first current at level `medium`, so the
/// picker holds a model other than the current one.
fn models() -> HostEvent {
	HostEvent::Snapshot(section(json!({ "Models": {
		"models": [
			{ "provider": "anthropic", "id": "claude-sonnet-4", "name": "Claude Sonnet 4",
				"reasoning": true, "context_window": 200_000, "max_output": 64_000 },
			{ "provider": "anthropic", "id": "claude-haiku-4", "name": "Claude Haiku 4",
				"reasoning": false, "context_window": 200_000, "max_output": 8_000 }
		],
		"current": { "provider": "anthropic", "id": "claude-sonnet-4" },
		"thinking_level": "medium",
		"thinking_levels": ["off", "low", "medium", "high"]
	} })))
}

pub(super) fn submit_prompt(w: &mut Win<'_>) {
	w.typed("Tidy the tests");
	w.keys("enter");
}

pub(super) fn abort_turn(w: &mut Win<'_>) {
	w.apply(vec![running()]);
	w.keys("secondary-.");
}

pub(super) fn steer(w: &mut Win<'_>) {
	w.apply(vec![running()]);
	w.typed("Check the tests too");
	w.keys("enter");
}

/// `/queue` sends the rest of the draft behind the turn whatever the queue
/// mode, as the terminal reads it.
pub(super) fn follow_up(w: &mut Win<'_>) {
	w.apply(vec![running()]);
	w.typed("/queue Then write the changelog");
	w.keys("enter");
}

/// Up on an empty draft recalls the prompts this composer sent; a fresh one
/// sent none, so it asks the host for its history.
pub(super) fn search_prompt_history(w: &mut Win<'_>) {
	w.keys("up");
}

pub(super) fn report_composer_draft(w: &mut Win<'_>) {
	w.typed("T");
}

/// The session's extensions state that they complete the draft.
pub(super) fn complete_composer(w: &mut Win<'_>) {
	w.apply(vec![corpus(SnapshotSectionKind::ExtensionUi)]);
	w.typed("T");
}

/// The host has listed no command yet, so the first `/` asks for them.
pub(super) fn list_commands(w: &mut Win<'_>) {
	w.typed("/");
}

pub(super) fn run_command(w: &mut Win<'_>) {
	w.apply(vec![corpus(SnapshotSectionKind::Commands)]);
	w.typed("/review the tree");
	w.keys("enter");
}

pub(super) fn search_files(w: &mut Win<'_>) {
	w.typed("@src");
}

/// The queue mode chip is drawn only while a turn runs.
pub(super) fn set_queue_mode(w: &mut Win<'_>) {
	w.apply(vec![running()]);
	click_text_in(w, "composer", "Steer");
}

pub(super) fn set_session_mode(w: &mut Win<'_>) {
	w.click("composer.mode");
	w.click_text("Vibe mode");
}

/// The mode menu offers the plan for review while the session is in plan
/// mode, which the corpus header states.
pub(super) fn review_plan(w: &mut Win<'_>) {
	w.apply(vec![corpus(SnapshotSectionKind::ActiveSession)]);
	w.click("composer.mode");
	w.click_text("Review the plan");
}

pub(super) fn select_model(w: &mut Win<'_>) {
	w.apply(vec![models()]);
	click_text_in(w, "composer", "Claude Sonnet 4");
	w.click_text("Claude Haiku 4");
}

/// The catalog has arrived, so opening the picker asks for nothing and the
/// row is what sends.
pub(super) fn refresh_models(w: &mut Win<'_>) {
	w.apply(vec![models()]);
	click_text_in(w, "composer", "Claude Sonnet 4");
	w.click_text("Refresh models");
}

pub(super) fn set_thinking_level(w: &mut Win<'_>) {
	w.apply(vec![models()]);
	click_text_in(w, "composer", "Thinking: medium");
	w.click_text("high");
}

/// The palette returns the keys to the composer before the row runs, so the
/// row reads the draft typed there.
pub(super) fn set_goal(w: &mut Win<'_>) {
	w.typed("Ship the parity work");
	w.palette("Set goal from the draft");
}

pub(super) fn toggle_dictation(w: &mut Win<'_>) {
	w.palette("Dictate");
}

pub(super) fn dequeue_queued_prompt(w: &mut Win<'_>) {
	w.apply(vec![running(), corpus(SnapshotSectionKind::QueuedPrompts)]);
	click_text_in(w, "composer", "Edit last");
}

pub(super) fn background_command(w: &mut Win<'_>) {
	w.apply(vec![running(), corpus(SnapshotSectionKind::ForegroundCommand)]);
	click_text_in(w, "composer", "Background");
}

/// The strip and its Cancel are drawn while a dictation records.
pub(super) fn cancel_dictation(w: &mut Win<'_>) {
	w.apply(vec![corpus(SnapshotSectionKind::Dictation)]);
	click_text_in(w, "composer", "Cancel");
}
