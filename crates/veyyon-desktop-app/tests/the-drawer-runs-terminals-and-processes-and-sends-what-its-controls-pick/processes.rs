//! The processes tab: what it starts, the controls on each process, and a
//! process's own tab with its output and the line it writes to it.

use gpui::TestAppContext;
use veyyon_desktop_app::drawer::DrawerTab;
use veyyon_desktop_model::{Capability, CapabilityStatus, HostAction, SupervisorSignal};

use super::harness::{logs, opened, process, processes, succeeded, window};

/// A host that supervises processes and runs no terminals.
fn supervisor_only() -> Vec<(Capability, CapabilityStatus)> {
	vec![
		(Capability::Terminals, CapabilityStatus::Unavailable {
			reason: "no pty on this host".to_owned(),
		}),
		(Capability::ProcessSupervisor, CapabilityStatus::Available),
	]
}

fn dev() -> String {
	"dev".to_owned()
}

#[gpui::test]
fn the_processes_tab_starts_a_command_and_acts_on_each_process_it_lists(app: &mut TestAppContext) {
	let mut w = window(app, opened(supervisor_only()));
	w.toggle();
	assert_eq!(
		w.shown(),
		Some(DrawerTab::Processes),
		"a host with no terminals opens on its processes"
	);
	assert_eq!(w.sent(), vec![HostAction::RefreshProcesses], "and asks for them once");
	assert!(w.draws("No supervised processes. Start a command above."));
	assert_eq!(w.bounds("drawer.control:new"), None, "no terminal is offered where none runs");

	w.submit("Command to start, as `bun run dev`", "bun run dev --port 3000");
	let start = w.one();
	assert_eq!(start.action, HostAction::ProcessStart {
		command: "bun".to_owned(),
		args:    vec!["run".to_owned(), "dev".to_owned(), "--port".to_owned(), "3000".to_owned()],
	});

	w.apply(vec![processes(vec![process("dev", "running", None)]), succeeded(start.id)]);
	assert!(w.bounds("drawer.process:dev").is_some());
	assert!(w.draws("bun run dev") && w.draws("pid 4242"));
	assert_eq!(w.strip(), vec![DrawerTab::Processes, DrawerTab::Process(dev())]);

	w.click("drawer.control:stop:dev");
	assert_eq!(w.sent(), vec![HostAction::ProcessStop { process_id: dev() }]);
	w.click("drawer.control:restart:dev");
	assert_eq!(w.sent(), vec![HostAction::ProcessRestart { process_id: dev() }]);
	w.click("drawer.control:signal:dev");
	w.click_text("Kill");
	assert_eq!(w.sent(), vec![HostAction::ProcessSignal {
		process_id: dev(),
		signal:     SupervisorSignal::Kill,
	}]);

	w.apply(vec![processes(vec![process("dev", "exited", Some(1))])]);
	assert!(w.draws("dev (exit 1)"), "an ended process's tab states how it ended");
	assert!(w.bounds("drawer.control:restart:dev").is_some(), "an ended process can be restarted");
	assert_eq!(w.bounds("drawer.control:stop:dev"), None, "and not stopped or signalled");
	assert_eq!(w.bounds("drawer.control:signal:dev"), None);
}

#[gpui::test]
fn a_process_tab_follows_its_output_and_writes_a_line_to_it(app: &mut TestAppContext) {
	let mut w = window(app, opened(supervisor_only()));
	w.apply(vec![processes(vec![process("dev", "running", None)])]);
	w.toggle();
	assert_eq!(w.sent(), Vec::<HostAction>::new(), "a listed supervisor is not asked again");

	w.click_text("Logs");
	assert_eq!(w.shown(), Some(DrawerTab::Process(dev())));
	assert_eq!(w.sent(), vec![HostAction::ProcessLogs { process_id: dev(), follow: true }]);
	w.apply(vec![logs("dev", &["compiled in 120ms", "ready on :3000"])]);
	assert!(w.draws("compiled in 120ms") && w.draws("ready on :3000"));

	w.submit("A line to write to the process", "rs");
	assert_eq!(w.sent(), vec![HostAction::ProcessSend {
		process_id: dev(),
		data:       b"rs\n".to_vec(),
	}]);
	assert_eq!(
		w.state
			.read_with(&*w.cx, |state, _| state.active_drawer_tab().map(str::to_owned)),
		Some("process:dev".to_owned()),
		"the session reopens on the process"
	);
}

#[gpui::test]
fn a_host_that_offers_neither_states_it(app: &mut TestAppContext) {
	let declined = |reason: &str| CapabilityStatus::Unavailable { reason: reason.to_owned() };
	let mut w = window(
		app,
		opened(vec![
			(Capability::Terminals, declined("no pty")),
			(Capability::ProcessSupervisor, declined("no supervisor")),
		]),
	);
	w.toggle();
	assert_eq!(w.strip(), Vec::<DrawerTab>::new());
	assert!(w.draws("The host runs no terminals and supervises no processes."));
	assert_eq!(w.sent(), Vec::<HostAction>::new());
}
