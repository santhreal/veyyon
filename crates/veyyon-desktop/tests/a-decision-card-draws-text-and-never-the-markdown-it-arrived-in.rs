//! WHY: a plan crosses the wire as `markdown_plan`, written for a markdown
//! renderer, and the desktop has none: the plan card and the run bar draw the
//! strings the projection hands them, one line per row. So the card drew
//! `- **Cut** the tag` with its markers and the bar drew `# Plan` with its
//! hash. The defect class is a marker authored for the terminal surviving into
//! a native surface, in any of the places a decision reaches one.
//!
//! The suite defends, through the real `project` projection and a real store:
//! 1. A plan's heading names the card once, in the title, and never again as a
//!    body row; the bar names the same line.
//! 2. Every block marker a plan body carries comes off, and the indent that
//!    states list depth stays.
//! 3. Every inline marker comes off, while the text a marker is NOT (a
//!    `snake_case` name, a multiplication, an unpaired asterisk) is untouched.
//! 4. An approval's detail is drawn as it arrived, because it states the
//!    command about to run, and the bar takes one line of it rather than
//!    embedding a newline in a one-line layout.
//! 5. A plan with no text at all projects a card with no title and no rows,
//!    rather than a row of markers.
//!
//! Gap left: it does not assert the rasterized frame, only the strings the
//! surfaces are handed; a card that draws its title in the wrong ramp is
//! caught by the token suites and the recorded pair, not here.

use std::collections::HashMap;

use veyyon_desktop::project::{SessionIndex, project};
use veyyon_desktop_model::{
	ApprovalInteraction, InteractionId, PendingDecisions, PlanInteraction, QueuePartition, Session,
	SessionId, SessionStatus, Store,
};
use veyyon_desktop_surface::{Badge, Card, ShellState};

const NOW_MS: u64 = 1_700_000_000_000;

fn session(id: &str) -> Session {
	Session {
		id:                SessionId::from(id),
		title:             format!("Session {id}"),
		project_name:      "test".to_string(),
		branch:            "main".to_string(),
		partition:         QueuePartition::Live,
		status:            SessionStatus::Unknown,
		modified_at_ms:    NOW_MS,
		read_mark_ms:      Some(NOW_MS),
		created_at_ms:     NOW_MS,
		last_recall_at_ms: NOW_MS,
		defer_until_ms:    None,
		parked_at_ms:      None,
		pin_key:           None,
	}
}

/// The shell state a session with `pending` decisions projects to.
fn shell(pending: PendingDecisions) -> ShellState {
	let mut store = Store::new();
	let id = SessionId::from("s1");
	store.sessions.insert(session("s1"));
	store.persisted.shell.active_session = Some(id.clone());
	store.interactions.insert(id, pending);
	let mut state = ShellState::default();
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
	state
}

fn plan(markdown: &str) -> PendingDecisions {
	PendingDecisions {
		plans: vec![PlanInteraction {
			id:              InteractionId::from("p1"),
			markdown_plan:   markdown.to_string(),
			requested_at_ms: NOW_MS,
		}],
		..PendingDecisions::new()
	}
}

fn approval(detail: &str) -> PendingDecisions {
	PendingDecisions {
		approvals: vec![ApprovalInteraction {
			id:              InteractionId::from("a1"),
			tool_name:       "bash".to_string(),
			detail:          detail.to_string(),
			requested_at_ms: NOW_MS,
		}],
		..PendingDecisions::new()
	}
}

/// The one plan card the state carries, as its title and its body rows.
fn plan_card(state: &ShellState) -> (String, Vec<String>) {
	match state.cards.as_slice() {
		[Card::Plan { title, body }] => (title.clone(), body.clone()),
		other => panic!("expected one plan card, got {other:?}"),
	}
}

#[test]
fn a_plan_heading_names_the_card_and_is_not_a_body_row() {
	let state = shell(plan("# Ship the tag\n\n1. Cut\n2. Push"));
	let (title, body) = plan_card(&state);
	assert_eq!(title, "Ship the tag");
	assert_eq!(body, vec!["1. Cut".to_string(), "2. Push".to_string()]);
	assert_eq!(state.run_status, Some((Badge::Plan, "Ship the tag".to_string())));
}

#[test]
fn a_plan_named_without_a_heading_is_named_by_its_first_line() {
	let state = shell(plan("Ship the tag\n- Cut\n"));
	let (title, body) = plan_card(&state);
	assert_eq!(title, "Ship the tag");
	assert_eq!(body, vec!["- Cut".to_string()]);
	assert_eq!(state.run_status, Some((Badge::Plan, "Ship the tag".to_string())));
}

#[test]
fn every_block_marker_comes_off_and_the_indent_that_states_depth_stays() {
	let markdown = concat!(
		"## Plan\n",
		"* top\n",
		"    + nested\n",
		"        - deeper\n",
		"> quoted\n",
		"```sh\n",
		"cargo test\n",
		"```\n",
		"###### six\n",
		"#nothash\n",
	);
	let (title, body) = plan_card(&shell(plan(markdown)));
	assert_eq!(title, "Plan");
	assert_eq!(body, vec![
		"- top".to_string(),
		"    - nested".to_string(),
		"        - deeper".to_string(),
		"quoted".to_string(),
		"cargo test".to_string(),
		"six".to_string(),
		"#nothash".to_string(),
	]);
}

#[test]
fn every_inline_marker_comes_off_and_what_is_not_a_marker_stays() {
	let cases = [
		("**bold**", "bold"),
		("__bold__", "bold"),
		("*em*", "em"),
		("_em_", "em"),
		("***both***", "both"),
		("`code`", "code"),
		("a **b** and `c` and _d_", "a b and c and d"),
		("[the plan](docs/plan.md)", "the plan (docs/plan.md)"),
		("![shot](a.png)", "shot (a.png)"),
		// What no markdown renderer would emphasize either.
		("snake_case_name", "snake_case_name"),
		("2 * 3 * 4", "2 * 3 * 4"),
		("a * b", "a * b"),
		("unpaired *marker", "unpaired *marker"),
		("unpaired `tick", "unpaired `tick"),
		("[not a link] then", "[not a link] then"),
		("`**literal**`", "**literal**"),
		("keep _ single", "keep _ single"),
	];
	for (markdown, drawn) in cases {
		let (_, body) = plan_card(&shell(plan(&format!("Plan\n{markdown}"))));
		assert_eq!(body, vec![drawn.to_string()], "flattening {markdown:?}");
	}
}

#[test]
fn an_approval_detail_is_drawn_as_it_arrived_and_the_bar_takes_one_line() {
	let detail = "Scope: This call only\n\nRequested action\nCommand: rm -rf `pwd`/build";
	let state = shell(approval(detail));
	assert_eq!(state.cards, vec![Card::Approval {
		tool:   "bash".to_string(),
		detail: vec![
			"Scope: This call only".to_string(),
			String::new(),
			"Requested action".to_string(),
			"Command: rm -rf `pwd`/build".to_string(),
		],
	}]);
	assert_eq!(
		state.run_status,
		Some((Badge::Approval, "bash · Scope: This call only".to_string()))
	);
}

#[test]
fn an_approval_with_no_detail_is_named_by_its_tool_alone() {
	let state = shell(approval(""));
	assert_eq!(state.run_status, Some((Badge::Approval, "bash".to_string())));
}

#[test]
fn a_plan_with_no_text_projects_no_title_and_no_rows() {
	for markdown in ["", "\n\n", "```\n```\n"] {
		let (title, body) = plan_card(&shell(plan(markdown)));
		assert_eq!(title, "", "titling {markdown:?}");
		assert_eq!(body, Vec::<String>::new(), "bodying {markdown:?}");
	}
	assert_eq!(shell(plan("")).run_status, Some((Badge::Plan, String::new())));
}

#[test]
fn a_plan_body_neither_opens_nor_closes_on_a_blank_row() {
	let (title, body) = plan_card(&shell(plan("# Plan\n\n\nfirst\n\nlast\n\n\n")));
	assert_eq!(title, "Plan");
	assert_eq!(body, vec!["first".to_string(), String::new(), "last".to_string()]);
}
