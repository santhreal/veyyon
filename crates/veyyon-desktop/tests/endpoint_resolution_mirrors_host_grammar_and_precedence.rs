use std::path::{Path, PathBuf};

use veyyon_desktop::{Endpoint, EndpointError, VEYYON_GUI_ENDPOINT_ENV};

#[test]
fn unix_endpoint_parses_absolute_and_relative_paths() {
	let endpoint =
		Endpoint::parse("unix:/var/run/veyyon.sock", None).expect("valid unix path should parse");
	assert_eq!(endpoint, Endpoint::Unix { path: PathBuf::from("/var/run/veyyon.sock") });
	assert_eq!(endpoint.formatted(), "unix:/var/run/veyyon.sock");

	let rel_endpoint =
		Endpoint::parse("unix:local.sock", None).expect("relative unix path should parse");
	assert_eq!(rel_endpoint, Endpoint::Unix { path: PathBuf::from("local.sock") });
	assert_eq!(rel_endpoint.formatted(), "unix:local.sock");
}

#[test]
fn empty_unix_endpoint_path_is_rejected_as_named_error() {
	let err1 = Endpoint::parse("unix:", None).unwrap_err();
	assert_eq!(err1, EndpointError::EmptyUnixPath);

	let err2 = Endpoint::parse("unix:   \t", None).unwrap_err();
	assert_eq!(err2, EndpointError::EmptyUnixPath);
}

#[test]
fn tcp_endpoint_parses_standard_and_empty_host_notations() {
	let ep1 = Endpoint::parse("tcp:127.0.0.1:7654", None).expect("standard tcp endpoint");
	assert_eq!(ep1, Endpoint::Tcp { host: "127.0.0.1".to_string(), port: 7654 });
	assert_eq!(ep1.formatted(), "tcp:127.0.0.1:7654");

	// Empty host defaults to 127.0.0.1
	let ep2 = Endpoint::parse("tcp::8080", None).expect("empty host should default to 127.0.0.1");
	assert_eq!(ep2, Endpoint::Tcp { host: "127.0.0.1".to_string(), port: 8080 });
	assert_eq!(ep2.formatted(), "tcp:127.0.0.1:8080");

	let ep3 = Endpoint::parse("tcp:host.internal:9000", None).expect("named host");
	assert_eq!(ep3, Endpoint::Tcp { host: "host.internal".to_string(), port: 9000 });
	assert_eq!(ep3.formatted(), "tcp:host.internal:9000");
}

#[test]
fn tcp_endpoint_missing_port_is_rejected_as_named_error() {
	let err = Endpoint::parse("tcp:127.0.0.1", None).unwrap_err();
	assert_eq!(err, EndpointError::MissingTcpPort("tcp:127.0.0.1".to_string()));
}

#[test]
fn tcp_endpoint_invalid_ports_are_rejected_as_named_error() {
	let zero_err = Endpoint::parse("tcp:127.0.0.1:0", None).unwrap_err();
	assert_eq!(zero_err, EndpointError::InvalidTcpPort("0".to_string()));

	let high_err = Endpoint::parse("tcp:127.0.0.1:65536", None).unwrap_err();
	assert_eq!(high_err, EndpointError::InvalidTcpPort("65536".to_string()));

	let alpha_err = Endpoint::parse("tcp:127.0.0.1:abc", None).unwrap_err();
	assert_eq!(alpha_err, EndpointError::InvalidTcpPort("abc".to_string()));
}

#[test]
fn bare_string_defaults_to_unix_socket_in_agent_dir() {
	let agent_dir = Path::new("/tmp/agent-test-dir");
	let endpoint =
		Endpoint::parse("no-scheme-value", Some(agent_dir)).expect("bare string fallback");
	assert_eq!(endpoint, Endpoint::Unix {
		path: PathBuf::from("/tmp/agent-test-dir/gui-host.sock"),
	});
}

#[test]
fn resolution_precedence_respects_explicit_over_env_over_default() {
	let agent_dir = Path::new("/tmp/profiles/work");

	// 1. Explicit override
	let explicit_ep =
		Endpoint::resolve(Some("tcp:10.0.0.1:5555"), agent_dir).expect("explicit endpoint overrides");
	assert_eq!(explicit_ep, Endpoint::Tcp { host: "10.0.0.1".to_string(), port: 5555 });

	// 2. Default fallback when no explicit or env
	let previous_env = std::env::var(VEYYON_GUI_ENDPOINT_ENV).ok();
	// SAFETY: single-threaded test modifying isolated environment variable
	unsafe { std::env::remove_var(VEYYON_GUI_ENDPOINT_ENV) };

	let default_ep = Endpoint::resolve(None, agent_dir).expect("default unix fallback");
	assert_eq!(default_ep, Endpoint::Unix {
		path: PathBuf::from("/tmp/profiles/work/gui-host.sock"),
	});

	// 3. Env var precedence
	// SAFETY: single-threaded test modifying isolated environment variable
	unsafe { std::env::set_var(VEYYON_GUI_ENDPOINT_ENV, "tcp:127.0.0.1:7654") };
	let env_ep = Endpoint::resolve(None, agent_dir).expect("env var resolution");
	assert_eq!(env_ep, Endpoint::Tcp { host: "127.0.0.1".to_string(), port: 7654 });

	// Cleanup env
	if let Some(val) = previous_env {
		// SAFETY: restoring original test environment variable
		unsafe { std::env::set_var(VEYYON_GUI_ENDPOINT_ENV, val) };
	} else {
		// SAFETY: restoring original test environment variable
		unsafe { std::env::remove_var(VEYYON_GUI_ENDPOINT_ENV) };
	}
}
