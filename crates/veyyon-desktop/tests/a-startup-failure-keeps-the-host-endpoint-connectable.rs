//! WHY: a cold host exceeded its startup deadline and the desktop never started
//! its transport, even after the host began listening. Startup failures must
//! preserve both their diagnostic and a usable endpoint for bounded retries.
//! This exercises real child processes, pipes and HostLink against a protocol
//! fixture. Native capture separately covers window responsiveness and
//! projection.

#![cfg(unix)]

use std::{
	env, fs,
	io::{BufRead, BufReader, Write},
	os::unix::{fs::PermissionsExt, net::UnixListener},
	path::Path,
	process::{Child, Command, Stdio},
	thread,
	time::{Duration, Instant},
};

use veyyon_desktop::{HostLink, HostSpawnError, SPAWN_WAIT_MS, connect_or_spawn};
use veyyon_desktop_model::{HostEvent, SnapshotSection};
use veyyon_test_scratch::scratch_dir;

const CASES: &[&str] =
	&["ready", "late", "reported", "exited", "malformed", "missing", "no-binary"];
const SOCKET: &str = "./.veyyon/profiles/p/agent/gui-host.sock";

struct OwnedChild(Child);
impl Drop for OwnedChild {
	fn drop(&mut self) {
		let _ = self.0.kill();
		let _ = self.0.wait();
	}
}

#[test]
fn a_startup_outcome_preserves_recovery_and_its_diagnostic() {
	let executable = env::current_exe().expect("test executable");
	for case in CASES {
		let tree = scratch_dir("host-startup");
		fs::create_dir_all(tree.join(".veyyon/profiles/p/agent")).expect("isolated profile");
		let launcher = tree.join("host");
		fs::write(
			&launcher,
			"#!/bin/sh\nexec \"$VEYYON_STARTUP_TEST\" --exact gui_fixture --ignored --nocapture\n",
		)
		.expect("fixture launcher");
		fs::set_permissions(&launcher, fs::Permissions::from_mode(0o700))
			.expect("executable launcher");
		let mut command = Command::new(&executable);
		command
			.args(["--exact", "connection_probe", "--ignored", "--nocapture"])
			.current_dir(&tree)
			.env("HOME", ".")
			.env("VEYYON_PROFILE", "p")
			.env_remove("VEYYON_GUI_ENDPOINT")
			.env("VEYYON_STARTUP_TEST", &executable)
			.env("STARTUP_CASE", case)
			.env("VEYYON_BIN", &launcher)
			.stdin(Stdio::null());
		if *case == "missing" {
			command.env("VEYYON_BIN", tree.join("missing-host"));
		} else if *case == "no-binary" {
			command.env_remove("VEYYON_BIN").env("PATH", "");
		}
		let mut child = OwnedChild(command.spawn().expect("isolated probe"));
		let deadline = Instant::now() + Duration::from_secs(20);
		loop {
			if let Some(status) = child.0.try_wait().expect("probe status") {
				assert!(status.success(), "startup case {case}: {status}");
				break;
			}
			assert!(Instant::now() < deadline, "startup case {case} exceeded its bound");
			thread::sleep(Duration::from_millis(10));
		}
	}
}

#[test]
#[ignore = "subprocess fixture with an isolated profile"]
fn connection_probe() {
	let case = env::var("STARTUP_CASE").expect("scenario");
	let start = Instant::now();
	let attachment =
		connect_or_spawn(None, Path::new(".")).expect("resolved target despite startup failure");
	assert!(start.elapsed() < Duration::from_millis(SPAWN_WAIT_MS + 1000));
	let outcome = match &attachment.spawned {
		Ok(Some(_)) => "ready",
		Ok(None) => panic!("a fresh profile must attempt host startup"),
		// Exhaustive: a new startup failure requires a recovery decision here.
		Err(error) => match error {
			HostSpawnError::NoBinary => "no-binary",
			HostSpawnError::SpawnFailed(..) => "missing",
			HostSpawnError::ExitedBeforeListening(message) => {
				assert!(message.contains("fixture startup rejected"));
				"exited"
			},
			HostSpawnError::NoEndpointLine => "late",
			HostSpawnError::BadEndpoint(_) => "malformed",
			HostSpawnError::NotListening { waited_ms, .. } => {
				assert_eq!(*waited_ms, SPAWN_WAIT_MS);
				"reported"
			},
		},
	};
	assert_eq!(outcome, case);
	let target = if case == "reported" {
		"reported.sock"
	} else {
		SOCKET
	};
	assert_eq!(attachment.endpoint.formatted(), format!("unix:{target}"));
	let replacement = if matches!(case.as_str(), "exited" | "malformed" | "missing" | "no-binary") {
		Some(OwnedChild(
			Command::new(env::current_exe().expect("executable"))
				.args(["--exact", "gui_fixture", "--ignored", "--nocapture"])
				.env("STARTUP_CASE", "ready")
				.stdin(Stdio::null())
				.stdout(Stdio::null())
				.spawn()
				.expect("replacement host"),
		))
	} else {
		None
	};
	let (link, mut events) =
		HostLink::start(attachment.endpoint).expect("transport starts after any spawn outcome");
	let runtime = tokio::runtime::Builder::new_current_thread()
		.enable_all()
		.build()
		.expect("event runtime");
	runtime.block_on(async {
		tokio::time::timeout(Duration::from_secs(8), async {
			while let Some(event) = events.recv().await {
				if let HostEvent::Snapshot(SnapshotSection::Sessions(sessions, errors)) = event {
					assert_eq!(sessions.revision, 17);
					assert!(sessions.value.is_empty());
					assert!(errors.is_empty());
					return;
				}
			}
			panic!("transport ended without answering ListSessions");
		})
		.await
		.expect("late host becomes usable within the retry bound");
	});
	drop(link);
	drop(replacement);
}

#[test]
#[ignore = "external host protocol fixture"]
fn gui_fixture() {
	let case = env::var("STARTUP_CASE").expect("scenario");
	if case == "exited" {
		eprintln!("fixture startup rejected");
		std::process::exit(19);
	}
	if case == "malformed" {
		println!("GUI engine host listening at unix:");
		return;
	}
	let target = if case == "reported" {
		"reported.sock"
	} else {
		SOCKET
	};
	if case == "reported" {
		println!("GUI engine host listening at unix:{target}");
	}
	if matches!(case.as_str(), "late" | "reported") {
		thread::sleep(Duration::from_millis(SPAWN_WAIT_MS + 400));
	}
	let listener = UnixListener::bind(target).expect("fixture endpoint");
	listener.set_nonblocking(true).expect("bounded accept");
	if case != "reported" {
		println!("GUI engine host listening at unix:{target}");
	}
	// A caller returning at the deadline must not close the child's stdout.
	for _ in 0..128 {
		println!("{}", "diagnostic ".repeat(128));
	}
	let deadline = Instant::now() + Duration::from_secs(10);
	while Instant::now() < deadline {
		let (mut stream, _) = match listener.accept() {
			Ok(accepted) => accepted,
			Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
				thread::sleep(Duration::from_millis(10));
				continue;
			},
			Err(error) => panic!("accept: {error}"),
		};
		stream
			.set_read_timeout(Some(Duration::from_secs(2)))
			.expect("bounded read");
		let greeting = format!(
			"{{\"ConnectionChanged\":{{\"Connected\":{{\"endpoint\":\"unix:{target}\",\"protocol\":\
			 1}}}}}}\n{{\"Snapshot\":{{\"Capabilities\":[]}}}}\n"
		);
		if stream.write_all(greeting.as_bytes()).is_err() {
			continue;
		}
		let mut line = String::new();
		if BufReader::new(&stream).read_line(&mut line).unwrap_or(0) == 0 {
			continue;
		}
		let request: serde_json::Value = serde_json::from_str(&line).expect("host request");
		assert_eq!(request["action"], "ListSessions");
		stream
			.write_all(b"{\"Snapshot\":{\"Sessions\":[{\"revision\":17,\"value\":[]},[]]}}\n")
			.expect("session snapshot");
		return;
	}
	panic!("no ListSessions request within the fixture bound");
}
