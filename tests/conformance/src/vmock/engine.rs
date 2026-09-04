//! Ephemeral loopback HTTP/1.1 provider server.

use std::{
	collections::HashMap,
	net::{IpAddr, Ipv4Addr, SocketAddr},
	sync::{
		Arc, Mutex, MutexGuard, PoisonError,
		atomic::{AtomicBool, Ordering},
	},
};

use tokio::{
	net::{TcpListener, TcpStream},
	task::JoinHandle,
};

use crate::vmock::{
	guard::NetworkDenyGuard,
	h2c::{H2ConnectionFault, handle_h2_connection, sniff_is_h2},
	http::{ConnectionAction, HttpReader, HttpRequest, write_bad_request, write_response},
	script::ResponseScript,
};

/// Route entry holding queued or static responses.
#[derive(Debug, Clone)]
pub(crate) enum RouteHandler {
	Static(ResponseScript),
	Fifo(Vec<ResponseScript>),
}

impl RouteHandler {
	pub(crate) fn next_response(&mut self) -> Option<ResponseScript> {
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
pub(crate) struct RouterState {
	pub(crate) routes:           HashMap<String, RouteHandler>,
	pub(crate) default_response: Option<ResponseScript>,
	pub(crate) recorded:         Vec<HttpRequest>,
	pub(crate) h2_fault:         Option<H2ConnectionFault>,
}

/// Take the router lock, recovering it if a panicking handler poisoned it.
///
/// Every path through the engine goes through here, because the alternative
/// spelling — `if let Ok(mut state) = router.lock()` — turns a poisoned mutex
/// into silence: writes become no-ops and `recorded_requests` returns an empty
/// vector, so a handler task that panicked surfaces as "the request never
/// arrived" on some unrelated assertion rather than as the panic it was. The
/// state behind this lock is a route table and a request log, and neither has
/// an invariant a panic can leave half-applied, so recovering the guard loses
/// nothing.
pub(crate) fn router_guard(router: &Mutex<RouterState>) -> MutexGuard<'_, RouterState> {
	router.lock().unwrap_or_else(PoisonError::into_inner)
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
					Ok((stream, _client_addr)) => {
						let router_task = Arc::clone(&router_clone);
						let running_task = Arc::clone(&running_clone);
						tokio::spawn(async move {
							// The transport is chosen by the client's first bytes rather than by
							// configuration: an h2c client opens with the 24-octet preface and
							// prior knowledge, anything else is read as HTTP/1.1. The sniff only
							// peeks, so whichever handler runs still reads from byte zero.
							match sniff_is_h2(&stream).await {
								Ok(Some(true)) => {
									handle_h2_connection(stream, router_task, running_task).await;
								},
								Ok(Some(false)) => serve_http1(stream, router_task, running_task).await,
								Ok(None) | Err(_) => {},
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
		router_guard(&self.router)
			.routes
			.insert(path.into(), RouteHandler::Static(script));
	}

	/// Register a static scripted response for a specific HTTP method and path
	/// (e.g. `POST /v1/chat/completions`).
	pub fn route_method(&self, method: &str, path: &str, script: ResponseScript) {
		let key = format!("{} {}", method.to_ascii_uppercase(), path);
		router_guard(&self.router)
			.routes
			.insert(key, RouteHandler::Static(script));
	}

	/// Register a FIFO sequence of scripted responses for a path.
	pub fn route_sequence(&self, path: impl Into<String>, scripts: Vec<ResponseScript>) {
		router_guard(&self.router)
			.routes
			.insert(path.into(), RouteHandler::Fifo(scripts));
	}

	/// Set the default fallback response when no matching route is found.
	pub fn set_default_response(&self, script: ResponseScript) {
		router_guard(&self.router).default_response = Some(script);
	}

	/// Get a clone of the network-deny guard initialized for this engine.
	#[must_use]
	pub fn deny_guard(&self) -> NetworkDenyGuard {
		self.deny_guard.clone()
	}

	/// Returns all HTTP requests recorded by this engine so far.
	#[must_use]
	pub fn recorded_requests(&self) -> Vec<HttpRequest> {
		router_guard(&self.router).recorded.clone()
	}

	/// Returns all HTTP requests recorded for a specific path.
	#[must_use]
	pub fn recorded_requests_for(&self, path: &str) -> Vec<HttpRequest> {
		router_guard(&self.router)
			.recorded
			.iter()
			.filter(|r| r.path == path)
			.cloned()
			.collect()
	}

	/// Returns the number of requests recorded so far.
	#[must_use]
	pub fn request_count(&self) -> usize {
		router_guard(&self.router).recorded.len()
	}

	/// Clear the recorded request log.
	pub fn clear_recorded(&self) {
		router_guard(&self.router).recorded.clear();
	}

	/// Install a fault that acts before any request stream on this engine.
	pub fn set_h2_connection_fault(&self, fault: H2ConnectionFault) {
		router_guard(&self.router).h2_fault = Some(fault);
	}

	/// Clear any installed connection-level HTTP/2 fault.
	pub fn clear_h2_connection_fault(&self) {
		router_guard(&self.router).h2_fault = None;
	}
}

/// Serve one HTTP/1.1 connection until the client leaves or a script closes it.
///
/// Keep-alive is the client's call: a request that asks for it is answered and
/// the loop reads again, and anything else — a script that closes, a dropped
/// connection, a parse error — ends the connection after one answer.
async fn serve_http1(
	mut stream: TcpStream,
	router: Arc<Mutex<RouterState>>,
	running: Arc<AtomicBool>,
) {
	let mut reader = HttpReader::new();
	while running.load(Ordering::Relaxed) {
		match reader.read_request(&mut stream).await {
			Ok(Some(request)) => {
				let is_keep_alive = request.is_keep_alive();
				let script = {
					let mut state = router_guard(&router);
					state.recorded.push(request.clone());
					let key_with_method = format!("{} {}", request.method, request.path);
					if let Some(handler) = state.routes.get_mut(&key_with_method) {
						handler.next_response()
					} else if let Some(handler) = state.routes.get_mut(&request.path) {
						handler.next_response()
					} else {
						state.default_response.clone()
					}
				};
				let script = script.unwrap_or_else(ResponseScript::ok);
				match write_response(&mut stream, &script, is_keep_alive).await {
					Ok(ConnectionAction::KeepAlive) => {},
					Ok(ConnectionAction::Close | ConnectionAction::Dropped) | Err(_) => break,
				}
			},
			// Clean EOF between requests.
			Ok(None) => break,
			Err(err) => {
				let _ = write_bad_request(&mut stream, &err.to_string()).await;
				break;
			},
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
