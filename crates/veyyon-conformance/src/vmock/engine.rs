//! Ephemeral loopback HTTP/1.1 provider server.

use std::{
	collections::HashMap,
	net::{IpAddr, Ipv4Addr, SocketAddr},
	sync::{
		Arc, Mutex,
		atomic::{AtomicBool, Ordering},
	},
};

use tokio::{net::TcpListener, task::JoinHandle};

use crate::vmock::{
	guard::NetworkDenyGuard,
	http::{HttpReader, HttpRequest, write_bad_request, write_response},
	script::ResponseScript,
};

/// Route entry holding queued or static responses.
#[derive(Debug, Clone)]
enum RouteHandler {
	Static(ResponseScript),
	Fifo(Vec<ResponseScript>),
}

impl RouteHandler {
	fn next_response(&mut self) -> Option<ResponseScript> {
		match self {
			Self::Static(s) => Some(s.clone()),
			Self::Fifo(queue) => {
				if queue.is_empty() {
					None
				} else {
					Some(queue.remove(0))
				}
			},
		}
	}
}

/// Shared internal router state.
#[derive(Debug, Default)]
struct RouterState {
	routes:           HashMap<String, RouteHandler>,
	default_response: Option<ResponseScript>,
	recorded:         Vec<HttpRequest>,
}

/// The virtual mock provider engine.
///
/// Binds an ephemeral port on `127.0.0.1`, parses HTTP/1.1 traffic, delivers
/// scripted byte-exact responses and faults, and shuts down on drop.
pub struct Engine {
	addr:        SocketAddr,
	router:      Arc<Mutex<RouterState>>,
	deny_guard:  NetworkDenyGuard,
	server_task: Option<JoinHandle<()>>,
	is_running:  Arc<AtomicBool>,
}

impl Engine {
	/// Bind an ephemeral port on `127.0.0.1` and spawn the background accept
	/// loop.
	///
	/// # Errors
	///
	/// Returns an I/O error if binding to loopback fails.
	pub async fn bind() -> Result<Self, std::io::Error> {
		let loopback = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0);
		let listener = TcpListener::bind(loopback).await?;
		let addr = listener.local_addr()?;

		let router = Arc::new(Mutex::new(RouterState::default()));
		let deny_guard = NetworkDenyGuard::new(addr);
		let is_running = Arc::new(AtomicBool::new(true));

		let router_clone = Arc::clone(&router);
		let running_clone = Arc::clone(&is_running);

		let server_task = tokio::spawn(async move {
			while running_clone.load(Ordering::Relaxed) {
				match listener.accept().await {
					Ok((mut stream, _client_addr)) => {
						let router_task = Arc::clone(&router_clone);
						let running_task = Arc::clone(&running_clone);
						tokio::spawn(async move {
							let mut reader = HttpReader::new();
							while running_task.load(Ordering::Relaxed) {
								match reader.read_request(&mut stream).await {
									Ok(Some(request)) => {
										let is_keep_alive = request.is_keep_alive();
										let script = {
											let mut state = match router_task.lock() {
												Ok(g) => g,
												Err(poisoned) => poisoned.into_inner(),
											};
											state.recorded.push(request.clone());

											// Match path or method+path
											let key_with_method =
												format!("{} {}", request.method, request.path);
											if let Some(h) = state.routes.get_mut(&key_with_method) {
												h.next_response()
											} else if let Some(h) = state.routes.get_mut(&request.path) {
												h.next_response()
											} else {
												state.default_response.clone()
											}
										};

										let script = script.unwrap_or_else(ResponseScript::ok);
										match write_response(&mut stream, &script, is_keep_alive).await {
											Ok(crate::vmock::http::ConnectionAction::KeepAlive) => {},
											Ok(
												crate::vmock::http::ConnectionAction::Close
												| crate::vmock::http::ConnectionAction::Dropped,
											)
											| Err(_) => break,
										}
									},
									Ok(None) => {
										// Clean EOF between requests
										break;
									},
									Err(err) => {
										let _ = write_bad_request(&mut stream, &err.to_string()).await;
										break;
									},
								}
							}
						});
					},
					Err(_) => {
						// Listener closed
						break;
					},
				}
			}
		});

		Ok(Self { addr, router, deny_guard, server_task: Some(server_task), is_running })
	}

	/// The bound loopback socket address.
	#[must_use]
	pub const fn addr(&self) -> SocketAddr {
		self.addr
	}

	/// The ephemeral port number assigned to this engine.
	#[must_use]
	pub const fn port(&self) -> u16 {
		self.addr.port()
	}

	/// The base HTTP URL (e.g. `http://127.0.0.1:54321`) to configure as provider `baseUrl`.
	#[must_use]
	pub fn base_url(&self) -> String {
		format!("http://127.0.0.1:{}", self.addr.port())
	}

	/// An absolute URL on this engine for the given path.
	#[must_use]
	pub fn url(&self, path: &str) -> String {
		let trimmed = path.strip_prefix('/').unwrap_or(path);
		format!("http://127.0.0.1:{}/{}", self.addr.port(), trimmed)
	}

	/// Register a static scripted response for a path (e.g.
	/// `/v1/chat/completions`).
	pub fn route(&self, path: impl Into<String>, script: ResponseScript) {
		if let Ok(mut state) = self.router.lock() {
			state
				.routes
				.insert(path.into(), RouteHandler::Static(script));
		}
	}

	/// Register a static scripted response for a specific HTTP method and path
	/// (e.g. `POST /v1/chat/completions`).
	pub fn route_method(&self, method: &str, path: &str, script: ResponseScript) {
		let key = format!("{} {}", method.to_ascii_uppercase(), path);
		if let Ok(mut state) = self.router.lock() {
			state.routes.insert(key, RouteHandler::Static(script));
		}
	}

	/// Register a FIFO sequence of scripted responses for a path.
	pub fn route_sequence(&self, path: impl Into<String>, scripts: Vec<ResponseScript>) {
		if let Ok(mut state) = self.router.lock() {
			state
				.routes
				.insert(path.into(), RouteHandler::Fifo(scripts));
		}
	}

	/// Set the default fallback response when no matching route is found.
	pub fn set_default_response(&self, script: ResponseScript) {
		if let Ok(mut state) = self.router.lock() {
			state.default_response = Some(script);
		}
	}

	/// Get a clone of the network-deny guard initialized for this engine.
	#[must_use]
	pub fn deny_guard(&self) -> NetworkDenyGuard {
		self.deny_guard.clone()
	}

	/// Returns all HTTP requests recorded by this engine so far.
	#[must_use]
	pub fn recorded_requests(&self) -> Vec<HttpRequest> {
		self
			.router
			.lock()
			.map_or_else(|_| Vec::new(), |s| s.recorded.clone())
	}

	/// Returns all HTTP requests recorded for a specific path.
	#[must_use]
	pub fn recorded_requests_for(&self, path: &str) -> Vec<HttpRequest> {
		self.router.lock().map_or_else(
			|_| Vec::new(),
			|s| {
				s.recorded
					.iter()
					.filter(|r| r.path == path)
					.cloned()
					.collect()
			},
		)
	}

	/// Returns the number of requests recorded so far.
	#[must_use]
	pub fn request_count(&self) -> usize {
		self.router.lock().map_or(0, |s| s.recorded.len())
	}

	/// Clear the recorded request log.
	pub fn clear_recorded(&self) {
		if let Ok(mut state) = self.router.lock() {
			state.recorded.clear();
		}
	}
}

impl Drop for Engine {
	fn drop(&mut self) {
		self.is_running.store(false, Ordering::Relaxed);
		if let Some(task) = self.server_task.take() {
			task.abort();
		}
	}
}
