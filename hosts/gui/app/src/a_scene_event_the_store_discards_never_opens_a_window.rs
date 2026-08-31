//! WHY THIS SUITE EXISTS.
//!
//! The approval and plan-review capture scenes recorded the state before their
//! own event. Each fixture appended a section event at the revision the base
//! snapshot had already used, the store discarded it as stale, the window drew
//! the conversation without the dialog, and the recording still passed its
//! pixel-delta check because the palette keystrokes the scene typed on the way
//! changed enough pixels on their own. A scene whose subject never reached the
//! replica is not evidence of anything, and nothing said so.
//!
//! THE CLASS THIS CLOSES.
//!
//! Every way a decoded scene event fails to reach the replica: a revision a
//! section has already taken, a revision that skips one, and an event for a
//! section that never arrived. Each is now a preflight refusal naming the line,
//! so the process exits before a window opens and the recorder fails instead of
//! writing a plausible frame.
//!
//! WHAT IT DOES NOT CATCH.
//!
//! That the state a fixture builds is the state its author meant, or that the
//! scene driver then drives the surface it names. This proves only that every
//! event a fixture carries is assimilated.

use std::io::Cursor;

use veyyon_gui_core::{HostEvent, Store, navigation::PaletteMode, palette};

use crate::bridge::scene;

const HEADER: &str = r#"{"schema":1}"#;
const PLAN_DISABLED: &str = r#"{"Snapshot":{"Plan":{"revision":1,"value":"Disabled"}}}"#;
const PLAN_ACTIVE_REVISION_1: &str = r##"{"Snapshot":{"Plan":{"revision":1,"value":{"Active":{"file_path":"plans/gui.md","workflow":"review","reentry":null,"content":{"Ready":"# Plan\n"},"approval":{"title":"GUI review","summary":"Review the visual plan","request":6}}}}}}"##;
const PLAN_ACTIVE_REVISION_2: &str = r##"{"Snapshot":{"Plan":{"revision":2,"value":{"Active":{"file_path":"plans/gui.md","workflow":"review","reentry":null,"content":{"Ready":"# Plan\n"},"approval":{"title":"GUI review","summary":"Review the visual plan","request":6}}}}}}"##;
const NO_INTERACTIONS: &str = r#"{"Snapshot":{"Interactions":{"revision":1,"value":[]}}}"#;

fn approval(revision: u64) -> String {
	format!(
		r#"{{"InteractionPresented":{{"revision":{revision},"request":{{"id":"interaction-approval","correlation":4,"agent":"agent-1","deadline_ms":null,"kind":{{"Approval":{{"tool":"tool-1","tool_name":"edit","tier":"Write","reason":"Writes project files","risk":"mutable","scope":"workspace","arguments":"edit hosts/gui/app/src/main.rs"}}}}}}}}}}"#
	)
}

fn decode(lines: &[&str]) -> Result<Vec<HostEvent>, String> {
	let text = format!("{}\n", lines.join("\n"));
	scene::decode("scene", Cursor::new(text)).map_err(|error| error.to_string())
}

fn refusal(lines: &[&str]) -> String {
	match decode(lines) {
		Ok(events) => panic!("a discarded event was accepted as {} events", events.len()),
		Err(message) => message,
	}
}

#[test]
fn a_snapshot_repeating_a_revision_the_section_holds_is_refused_with_its_line() {
	let message = refusal(&[HEADER, PLAN_DISABLED, PLAN_ACTIVE_REVISION_1]);
	assert!(message.starts_with("discarded HostEvent in scene scene line 3:"), "{message}");
	// The refusal quotes the line, so the person reading stderr can see which
	// revision was refused without opening the fixture.
	assert!(message.contains(r#""revision":1"#), "{message}");
}

#[test]
fn a_section_event_repeating_a_revision_the_section_holds_is_refused() {
	let approval = approval(1);
	let message = refusal(&[HEADER, NO_INTERACTIONS, &approval]);
	assert!(message.starts_with("discarded HostEvent in scene scene line 3:"), "{message}");
	assert!(message.contains("interaction-approval"), "{message}");
}

#[test]
fn a_section_event_that_skips_a_revision_is_refused() {
	let approval = approval(3);
	let message = refusal(&[HEADER, NO_INTERACTIONS, &approval]);
	assert!(message.starts_with("discarded HostEvent in scene scene line 3:"), "{message}");
}

#[test]
fn a_section_event_for_a_section_that_never_arrived_is_refused() {
	let approval = approval(1);
	let message = refusal(&[HEADER, &approval]);
	assert!(message.starts_with("discarded HostEvent in scene scene line 2:"), "{message}");
}

#[test]
fn the_first_snapshot_of_a_section_is_kept_at_any_revision() {
	let events = decode(&[HEADER, PLAN_ACTIVE_REVISION_2]).expect("an opening snapshot");
	assert_eq!(events.len(), 1);
}

#[test]
fn a_scene_that_assimilates_offers_the_plan_and_the_approval_it_names() {
	let approval = approval(2);
	let events =
		decode(&[HEADER, PLAN_DISABLED, NO_INTERACTIONS, PLAN_ACTIVE_REVISION_2, &approval])
			.expect("every event lands");
	let mut store = Store::detached();
	for event in events {
		assert!(!store.apply(event).ignored_stale_event);
	}

	let interactions = store
		.replica
		.interactions
		.readable()
		.expect("the interaction section");
	let ids: Vec<&str> = interactions
		.value
		.iter()
		.map(|request| request.id.as_str())
		.collect();
	assert_eq!(ids, vec!["interaction-approval"]);

	let groups = palette::results(&store, PaletteMode::Commands, "").groups;
	let content = groups
		.iter()
		.find(|group| group.id == "content")
		.expect("the conversation's own group");
	let titles: Vec<&str> = content
		.items
		.iter()
		.map(|item| item.title.as_str())
		.collect();
	assert_eq!(titles, vec!["Review plan"]);
}
