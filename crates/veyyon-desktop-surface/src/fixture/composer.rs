//! The composer band of the fixture state: the controls the footer draws and
//! the plan its chip tallies.
//!
//! Split from the fixture root so the state builder reads as a list of the
//! surfaces it seeds rather than carrying the body of each one.

use veyyon_desktop_model::{InputModality, TodoBoardView, TodoPhaseView, TodoStatus, TodoTaskView};

use crate::composer::{
	ComposerState, ContextMeter, ModelChoice, ModelControl, ModelOption, ThinkingControl,
};

/// A footer with every control the host can report: a model the operator
/// can change, a thinking level with somewhere to go, a context meter and a
/// plan to tally.
pub fn fixture_composer() -> ComposerState {
	let sonnet =
		ModelChoice { provider: "anthropic".to_owned(), model: "claude-sonnet-4.5".to_owned() };
	let opus =
		ModelChoice { provider: "anthropic".to_owned(), model: "claude-opus-4.1".to_owned() };
	ComposerState {
		model: Some(ModelControl {
			current: Some(sonnet.clone()),
			options: vec![
				ModelOption {
					choice:    sonnet,
					name:      "Claude Sonnet 4.5".to_owned(),
					reasoning: true,
					input:     vec![InputModality::Text, InputModality::Image],
				},
				ModelOption {
					choice:    opus,
					name:      "Claude Opus 4.1".to_owned(),
					reasoning: true,
					input:     vec![InputModality::Text, InputModality::Image],
				},
			],
		}),
		thinking: Some(ThinkingControl {
			level:  "high".to_owned(),
			levels: ["off", "low", "medium", "high"].map(str::to_owned).to_vec(),
		}),
		context: Some(ContextMeter { used_tokens: 82_400, limit_tokens: Some(200_000) }),
		todo: Some(fixture_todo()),
		..ComposerState::default()
	}
}

/// The plan the fixture session is working: two phases, one closed task, and
/// a task in flight, so the chip carries a tally that is neither empty nor
/// finished and the popover has a phase list to state.
fn fixture_todo() -> TodoBoardView {
	let current = TodoTaskView {
		content: "Draw the plan in the composer band".to_owned(),
		status:  TodoStatus::InProgress,
	};
	TodoBoardView {
		phases:  vec![
			TodoPhaseView {
				name:   "I. Wire".to_owned(),
				tasks:  vec![TodoTaskView {
					content: "Publish the board at each todo result".to_owned(),
					status:  TodoStatus::Completed,
				}],
				closed: 1,
				active: false,
			},
			TodoPhaseView {
				name:   "II. Surface".to_owned(),
				tasks:  vec![current.clone(), TodoTaskView {
					content: "Sweep every measure the card authors".to_owned(),
					status:  TodoStatus::Pending,
				}],
				closed: 0,
				active: true,
			},
		],
		closed:  1,
		total:   3,
		current: Some(current),
	}
}
