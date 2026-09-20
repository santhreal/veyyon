//! WHY: a child host that failed took its reason with it.
//!
//! The window spawned `veyyon gui`, drained its stderr into a channel that
//! nobody read once startup was over, and drew "Socket connection lost" when
//! the socket dropped. The host had printed why — a port in use, a profile it
//! could not open, a panic — and the window discarded that text in the same
//! process, so the operator saw the symptom and no cause.
//!
//! The class this closes is a host failure whose reason exists and is not
//! shown, in either of the two places one is reached: the startup path, which
//! ends in `HostSpawnError::ExitedBeforeListening`, and every later transport
//! state that carries a message, which is `Reconnecting` and `Fatal`. The
//! sweep over `ConnectionState` fails when a variant gains a message and no
//! decision is recorded for it.
//!
//! What it does not catch: the GPUI draw. These tests assert the text the
//! banner is given, not the pixels it becomes; the banner's own rendering is
//! covered by the shell suites.

use std::{
	fs,
	os::unix::fs::PermissionsExt as _,
	path::{Path, PathBuf},
	time::Instant,
};

use veyyon_desktop::{HostSpawnError, HostStderr, last_words, spawn_host_binary};
use veyyon_desktop_model::ConnectionState;
use veyyon_test_scratch::TempTree;

/// The same bound the window applies when it quotes the host.
const HOST_WORDS_LINES: usize = 3;

/// A fake host binary in `dir` that writes `said` to stderr and exits `code`
/// without ever printing an endpoint.
fn failing_host(dir: &Path, said: &[String], code: i32) -> PathBuf {
	let path = dir.join("veyyon");
	let mut script = String::from("#!/bin/sh\n");
	for line in said {
		script.push_str("echo '");
		script.push_str(&line.replace('\'', ""));
		script.push_str("' >&2\n");
	}
	script.push_str("exit ");
	script.push_str(&code.to_string());
	script.push('\n');
	fs::write(&path, script).expect("fake host is written");
	fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("fake host is executable");
	path
}

fn host_that_dies(label: &str, said: &[&str], code: i32) -> (TempTree, HostSpawnError) {
	let owned: Vec<String> = said.iter().map(|line| (*line).to_string()).collect();
	host_that_dies_saying(label, &owned, code)
}

fn host_that_dies_saying(label: &str, said: &[String], code: i32) -> (TempTree, HostSpawnError) {
	let tree = veyyon_test_scratch::scratch_dir(label);
	let bin = failing_host(tree.path(), said, code);
	let failure = spawn_host_binary(&bin, tree.path()).expect_err("the fake host never listens");
	(tree, failure)
}

fn reason(failure: &HostSpawnError) -> String {
	match failure {
		HostSpawnError::ExitedBeforeListening(said) => said.clone(),
		other => panic!("a host that exits before listening reports that, got {other:?}"),
	}
}

#[test]
fn a_host_that_exits_before_listening_carries_what_it_printed() {
	let started = Instant::now();
	let (_tree, failure) =
		host_that_dies("host-words-startup", &["veyyon: profile work is locked by pid 41"], 1);

	// The startup path ends on the child's exit, not on the 5s deadline.
	assert!(
		started.elapsed().as_millis() < 3000,
		"a child that exits ends the wait, waited {:?}",
		started.elapsed()
	);
	let said = reason(&failure);
	assert!(
		said.contains("profile work is locked by pid 41"),
		"the host's own words reach the error, got {said}"
	);
	assert!(said.contains("exit status: 1"), "the exit status stays, got {said}");
}

#[test]
fn a_silent_host_reports_its_status_alone() {
	let (_tree, failure) = host_that_dies("host-words-silent", &[], 3);

	assert_eq!(
		reason(&failure),
		"exit status: 3",
		"a host that said nothing states its status only"
	);
}

#[test]
fn a_host_that_floods_its_stderr_keeps_the_end_of_it() {
	let said: Vec<String> = (0..500).map(|n| format!("line {n}")).collect();
	let (_tree, failure) = host_that_dies_saying("host-words-flood", &said, 1);

	let kept = reason(&failure);
	assert!(kept.contains("line 499"), "the last line the host wrote is kept");
	assert!(!kept.contains("line 0\n"), "the first of 500 lines is dropped, not the last");
	assert!(
		kept.lines().count() <= 201,
		"the kept stream is bounded, got {} lines",
		kept.lines().count()
	);
}

#[test]
fn the_banner_quotes_the_end_of_the_stream_and_nothing_blank() {
	let lines =
		|said: &[&str]| -> Vec<String> { said.iter().map(|line| (*line).to_string()).collect() };

	assert_eq!(last_words(&[], HOST_WORDS_LINES), None, "a host that said nothing quotes nothing");
	assert_eq!(
		last_words(&lines(&["", "  ", "\t"]), HOST_WORDS_LINES),
		None,
		"blank output is nothing to quote"
	);
	assert_eq!(
		last_words(&lines(&["  bind: address in use  "]), HOST_WORDS_LINES),
		Some("bind: address in use".to_string()),
		"a single line is quoted without its padding"
	);
	assert_eq!(
		last_words(&lines(&["one", "two", "three", "four", "five"]), HOST_WORDS_LINES),
		Some("three; four; five".to_string()),
		"the quote is the tail, in the order the host wrote it"
	);
	assert_eq!(
		last_words(&lines(&["one", "", "two"]), HOST_WORDS_LINES),
		Some("one; two".to_string()),
		"a blank line between two reasons does not become a reason"
	);
	assert_eq!(
		last_words(&lines(&["one", "two"]), 0),
		None,
		"a bound of none quotes nothing rather than everything"
	);
}

#[test]
fn two_handles_to_one_host_are_one_host() {
	let kept = HostStderr::default();
	let other = HostStderr::default();

	// The window compares state every frame, and the handle moves with it.
	// A clone is the same stream; a second host is a different one.
	assert_eq!(kept.clone(), kept, "a clone of a handle is the same host");
	assert_ne!(kept, other, "two hosts are not one host");
}

/// The reason a state carries, by an exhaustive match: a `ConnectionState`
/// variant added later fails to compile here until someone decides whether
/// the host's words belong in it.
const fn carried_reason(state: &ConnectionState) -> Option<&str> {
	match state {
		ConnectionState::Detached
		| ConnectionState::Connecting { .. }
		| ConnectionState::Syncing { .. }
		| ConnectionState::Connected { .. } => None,
		ConnectionState::Reconnecting { message, .. } | ConnectionState::Fatal { message } => {
			Some(message.as_str())
		},
	}
}

#[test]
fn the_states_that_carry_a_reason_are_the_states_the_window_enriches() {
	let states = [
		("Detached", ConnectionState::Detached, None),
		("Connecting", ConnectionState::Connecting { attempt: 1 }, None),
		("Syncing", ConnectionState::Syncing { received: 1, expected: Some(2) }, None),
		(
			"Connected",
			ConnectionState::Connected { endpoint: "unix:/run/veyyon.sock".to_string(), protocol: 1 },
			None,
		),
		(
			"Reconnecting",
			ConnectionState::Reconnecting {
				attempt:     2,
				retry_at_ms: 0,
				message:     "Socket connection lost".to_string(),
			},
			Some("Socket connection lost"),
		),
		(
			"Fatal",
			ConnectionState::Fatal { message: "Connection lost".to_string() },
			Some("Connection lost"),
		),
	];

	for (name, state, expected) in &states {
		assert_eq!(carried_reason(state), *expected, "{name} carries the reason this test expects");
	}
	let enriched: Vec<&str> = states
		.iter()
		.filter(|(_, state, _)| carried_reason(state).is_some())
		.map(|(name, ..)| *name)
		.collect();
	assert_eq!(
		enriched,
		vec!["Reconnecting", "Fatal"],
		"the states that carry a reason are the states the window enriches"
	);
}
