//! The plan a session is working, seeded for the capability gate scenes.

use veyyon_desktop_model::{SessionId, TodoBoardView, TodoPhaseView, TodoStatus, TodoTaskView};

use crate::scene::seed::Seed;

/// Seeds a session holding a plan, so the composer draws the chip.
///
/// The chip is drawn from the board's presence, so the scene records one: a
/// session with no board draws no chip at all and states nothing about what
/// the capability reaches. Two phases with one closed task between them, so
/// the tally, the phase name and both marks are on the frame.
pub fn seed_todo_board(seed: &mut Seed, session: &SessionId) {
	seed.exchange(session, Seed::prose());
	let current = TodoTaskView {
		content: "Publish the board at each todo result".to_owned(),
		status:  TodoStatus::InProgress,
	};
	seed.store.domains.todo.insert(session.clone(), TodoBoardView {
		phases:  vec![
			TodoPhaseView {
				name:   "I. Wire".to_owned(),
				tasks:  vec![
					current.clone(),
					TodoTaskView {
						content: "Project the phases the session records".to_owned(),
						status:  TodoStatus::Completed,
					},
				],
				closed: 1,
				active: true,
			},
			TodoPhaseView {
				name:   "II. Surface".to_owned(),
				tasks:  vec![TodoTaskView {
					content: "Draw the plan in the composer band".to_owned(),
					status:  TodoStatus::Pending,
				}],
				closed: 0,
				active: false,
			},
		],
		closed:  1,
		total:   3,
		current: Some(current),
	});
}
