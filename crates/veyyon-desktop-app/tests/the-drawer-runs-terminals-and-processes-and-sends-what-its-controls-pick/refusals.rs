//! A request a drawer control sent and the host refused is stated in the
//! drawer in the host's own sentence, with a Retry exactly when the host said
//! it takes a second send, and a dismissal that forgets it.
//!
//! WHY: the drawer's row read "The host refused clearing the terminal." and
//! stopped: the sentence the host gave for the refusal was dropped, and Retry
//! was drawn under every refusal, so a request the host called final was
//! offered again. Every control the drawer draws on a running terminal and on
//! a supervised process is refused once as retryable and once as final.
//!
//! Gap: the controls are named here from the targets the drawer registers,
//! not enumerated; `SurfaceId::in_terminal_drawer` is the exhaustive match a
//! new drawer control must pass before it compiles.

use gpui::TestAppContext;
use veyyon_desktop_model::{HostEvent, RequestId};

use super::{
	harness::{Win, process, processes, refused, succeeded},
	running,
};

/// The host refusing `request` with `message` and calling the refusal final.
fn refused_finally(request: RequestId, message: &str) -> HostEvent {
	let mut event = refused(request, message);
	if let HostEvent::RequestFailed { error, .. } = &mut event {
		error.retryable = false;
	}
	event
}

/// Presses `control`, has the host refuse it with a sentence of its own,
/// once taking a second send and once not, and reads the row back.
fn refuse_each_way(w: &mut Win<'_>, control: &str) {
	for retryable in [true, false] {
		w.click(control);
		let sent = w.one();
		let sentence = format!("{control} refused, retryable {retryable}");
		w.apply(vec![if retryable {
			refused(sent.id, &sentence)
		} else {
			refused_finally(sent.id, &sentence)
		}]);
		assert!(w.draws(&sentence), "the drawer states {sentence:?}: {:?}", w.texts());
		assert_eq!(
			w.bounds("drawer.retry").is_some(),
			retryable,
			"{control} offers Retry exactly when the host takes it again"
		);
		if retryable {
			w.click("drawer.retry");
			let again = w.one();
			assert_eq!(again.action, sent.action, "Retry sends {control}'s request again");
			// The host takes the second send, so the control is free to press again.
			w.apply(vec![succeeded(again.id)]);
		} else {
			w.click("drawer.dismiss");
			// A process tab asks for its list again once no refusal holds it.
			assert!(!w.sent().contains(&sent.action), "dismissing does not send {control} again");
		}
		assert!(!w.draws(&sentence), "{control}'s refusal is gone once answered");
		assert_eq!(w.bounds("drawer.refused"), None, "and its row with it");
	}
}

#[gpui::test]
fn every_drawer_control_states_the_hosts_sentence_and_offers_retry_only_when_taken(
	app: &mut TestAppContext,
) {
	let mut w = running(app);
	for control in ["drawer.control:clear", "drawer.control:restart", "drawer.control:close"] {
		refuse_each_way(&mut w, control);
	}

	w.apply(vec![processes(vec![process("dev", "running", None)])]);
	w.click("drawer.tab:processes");
	w.requests();
	for control in ["drawer.control:stop:dev", "drawer.control:restart:dev"] {
		refuse_each_way(&mut w, control);
	}
}
