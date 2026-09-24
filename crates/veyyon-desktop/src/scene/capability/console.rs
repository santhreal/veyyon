//! The autoswarm console a capability frame reaches (§5.8).
//!
//! The reachable surface is the console card, which the host opens: a frame of
//! the palette proves the command is listed and nothing about the controls the
//! capability gates. The console is seeded before a swarm has started, because
//! that is the state the setup rows and the primary action are drawn in, and a
//! start is what this capability answers for.
//!
//! The view goes on the store as well as on the overlay: the card is filled
//! from `store.domains.autoswarm` at every projection, so a view written only
//! onto the overlay is replaced by the domain before the first frame.

use veyyon_desktop_model::{
	AutoswarmAction, AutoswarmActionView, AutoswarmConsoleView, AutoswarmFieldKind,
	AutoswarmFieldView, AutoswarmNoteView, AutoswarmOptionView, AutoswarmRunView, SessionId,
};
use veyyon_desktop_surface::{AutoswarmState, Overlay};

use crate::scene::seed::Seed;

/// Seeds the console card for `session`, in the state a setup is drawn in.
pub fn seed_autoswarm_console(seed: &mut Seed, session: &SessionId) {
	seed.exchange(session, Seed::prose());
	let console = console_view(session);
	seed
		.store
		.domains
		.autoswarm
		.insert(session.clone(), console.clone());
	let mut state = AutoswarmState::new();
	state.console = Some(console);
	seed.state.overlay = Some(Overlay::Autoswarm(Box::new(state)));
}

fn console_view(session: &SessionId) -> AutoswarmConsoleView {
	AutoswarmConsoleView {
		session:    session.0.clone(),
		swarm:      None,
		fields:     vec![
			AutoswarmFieldView {
				id:          "goal".to_owned(),
				kind:        AutoswarmFieldKind::Text,
				label:       "Goal".to_owned(),
				hint:        "What the swarm optimizes".to_owned(),
				display:     "lower p50 latency".to_owned(),
				text:        Some("lower p50 latency".to_owned()),
				placeholder: Some("what to optimize".to_owned()),
				number:      None,
				min:         None,
				max:         None,
				on:          None,
				options:     Vec::new(),
			},
			AutoswarmFieldView {
				id:          "arms".to_owned(),
				kind:        AutoswarmFieldKind::Stepper,
				label:       "Arms".to_owned(),
				hint:        "How many candidates run at once".to_owned(),
				display:     "3 arms".to_owned(),
				text:        None,
				placeholder: None,
				number:      Some(3),
				min:         Some(1),
				max:         Some(8),
				on:          None,
				options:     Vec::new(),
			},
			AutoswarmFieldView {
				id:          "preset".to_owned(),
				kind:        AutoswarmFieldKind::Segmented,
				label:       "Preset".to_owned(),
				hint:        "The setup the rows start from".to_owned(),
				display:     "Tuned".to_owned(),
				text:        Some("tuned".to_owned()),
				placeholder: None,
				number:      None,
				min:         None,
				max:         None,
				on:          None,
				options:     vec![
					AutoswarmOptionView {
						value:     "balanced".to_owned(),
						label:     "Balanced".to_owned(),
						selected:  false,
						removable: false,
					},
					AutoswarmOptionView {
						value:     "wide".to_owned(),
						label:     "Wide".to_owned(),
						selected:  false,
						removable: false,
					},
					// A preset saved from this console, which is the one the
					// row offers a delete for. A built-in offers none.
					AutoswarmOptionView {
						value:     "tuned".to_owned(),
						label:     "Tuned".to_owned(),
						selected:  true,
						removable: true,
					},
				],
			},
			AutoswarmFieldView {
				id:          "save".to_owned(),
				kind:        AutoswarmFieldKind::Text,
				label:       "Save as".to_owned(),
				hint:        "The name this setup is saved under".to_owned(),
				display:     String::new(),
				text:        Some(String::new()),
				placeholder: Some("preset name".to_owned()),
				number:      None,
				min:         None,
				max:         None,
				on:          None,
				options:     Vec::new(),
			},
		],
		notes:      vec![AutoswarmNoteView {
			id:   "cost".to_owned(),
			text: "3 arms on the bench harness, about 12 minutes a round.".to_owned(),
		}],
		actions:    vec![
			AutoswarmActionView {
				action:  AutoswarmAction::Start,
				label:   "Start".to_owned(),
				verb:    "Runs the first round on this setup".to_owned(),
				primary: true,
				blocker: None,
			},
			AutoswarmActionView {
				action:  AutoswarmAction::Resume,
				label:   "Resume".to_owned(),
				verb:    "Continues the swarm on this branch".to_owned(),
				primary: false,
				blocker: Some("No swarm is recorded on this branch".to_owned()),
			},
		],
		runs:       vec![AutoswarmRunView {
			label:   "run 1".to_owned(),
			arm:     Some("baseline".to_owned()),
			metric:  "44 ms".to_owned(),
			delta:   None,
			outcome: "baseline".to_owned(),
			best:    true,
			detail:  Vec::new(),
		}],
		// The console's own save row, which is what the save control commits.
		save_field: Some("save".to_owned()),
	}
}
