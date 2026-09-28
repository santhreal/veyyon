//! Answering driver requests against the focused window, on the app's
//! foreground thread. A socket client and an in-process [`super::Client`]
//! both come through [`answer`].

use gpui::{ActionBuildError, AnyWindowHandle, App, Global, Keystroke, Modifiers, Window};
use serde_json::Value;

use super::{
	probe,
	protocol::{self, Condition, Request},
};

/// A request line and where its reply goes.
pub(super) struct Incoming {
	pub(super) line:  String,
	pub(super) reply: flume::Sender<String>,
}

/// A `wait` request whose condition did not hold yet.
struct Wait {
	id:        Value,
	condition: Condition,
	reply:     flume::Sender<String>,
}

/// The clients subscribed to frame events, the painted frame count, the
/// waits checked after each frame, and the window whose next frame re-checks
/// them.
#[derive(Default)]
struct Frames {
	subscribers: Vec<flume::Sender<String>>,
	painted:     u64,
	waits:       Vec<Wait>,
	armed:       Option<AnyWindowHandle>,
}

impl Global for Frames {}

/// Turns the driver on for this app: targets record their bounds and the
/// workspace reports its frames.
pub(super) fn install(cx: &mut App) {
	super::enable();
	cx.default_global::<Frames>();
}

/// The wait requests parked until their condition holds.
pub(super) fn waiting(cx: &App) -> usize {
	cx.try_global::<Frames>()
		.map_or(0, |frames| frames.waits.len())
}

/// Answers one request line. A `wait` whose condition does not hold yet is
/// parked and answered after a later frame.
pub(super) fn answer(request: Incoming, cx: &mut App) {
	let (id, parsed) = protocol::parse(&request.line);
	let result = match parsed {
		Err(message) => Err(message),
		Ok(Request::Dispatch { name, args }) => dispatch(&name, args, cx).map(|()| protocol::ok(&id)),
		Ok(Request::Type(text)) => {
			in_window(cx, |window, cx| type_text(&text, window, cx)).map(|()| protocol::ok(&id))
		},
		Ok(Request::Bounds(target)) => focused(cx)
			.ok_or_else(no_window)
			.and_then(|window| {
				super::bounds(cx, window.window_id(), &target)
					.ok_or_else(|| format!("no target `{target}` is laid out"))
			})
			.map(|bounds| protocol::bounds(&id, bounds)),
		Ok(Request::SubscribeFrames) => {
			cx.default_global::<Frames>()
				.subscribers
				.push(request.reply.clone());
			Ok(protocol::ok(&id))
		},
		Ok(Request::Wait(condition)) => match holds(&condition, cx) {
			Ok(true) => Ok(protocol::ok(&id)),
			Ok(false) => {
				park(Wait { id, condition, reply: request.reply }, cx);
				return;
			},
			Err(message) => Err(message),
		},
	};
	let reply = result.unwrap_or_else(|message| protocol::error(&id, &message));
	// A client that hung up before its reply needs none.
	request.reply.send(reply).ok();
}

fn no_window() -> String {
	"no window is open".to_owned()
}

fn dispatch(name: &str, args: Option<Value>, cx: &mut App) -> Result<(), String> {
	let action = cx.build_action(name, args).map_err(|error| match error {
		ActionBuildError::NotFound { name } => format!("no action is registered as `{name}`"),
		ActionBuildError::BuildError { name, error } => {
			format!("`{name}` cannot be built from `args`: {error}")
		},
	})?;
	in_window(cx, move |window, cx| window.dispatch_action(action, cx))
}

/// Whether `condition` holds in the focused window now.
fn holds(condition: &Condition, cx: &mut App) -> Result<bool, String> {
	match condition {
		Condition::Idle => in_window(cx, |window, _| !probe::frame_pending(window)),
		Condition::Text { target, contains } => {
			let window = focused(cx).ok_or_else(no_window)?;
			// A target not laid out yet is not drawn yet: the wait goes on.
			let Some(bounds) = super::bounds(cx, window.window_id(), target) else {
				return Ok(false);
			};
			in_window(cx, |window, _| {
				probe::rendered_text(window, bounds)
					.concat()
					.contains(contains.as_str())
			})
		},
	}
}

/// Parks `wait` until a frame makes its condition hold.
fn park(wait: Wait, cx: &mut App) {
	let idle = wait.condition == Condition::Idle;
	cx.default_global::<Frames>().waits.push(wait);
	if idle {
		arm(cx);
	}
}

/// Re-checks the parked waits once the focused window served its next frame.
///
/// A painted frame re-checks them through [`frame_painted`], but a frame that
/// only presents what an earlier draw painted reaches no paint, and that
/// frame is often the one that leaves the window idle. The check runs in a
/// task of its own, which starts after the whole frame, present included.
fn arm(cx: &mut App) {
	let Some(window) = focused(cx) else { return };
	let frames = cx.default_global::<Frames>();
	if frames.armed == Some(window) {
		return;
	}
	frames.armed = Some(window);
	let armed = window.update(cx, |_, window, _| {
		window.on_next_frame(|_, cx| {
			cx.default_global::<Frames>().armed = None;
			cx.spawn(async |cx| cx.update(settle_waits)).detach();
		});
	});
	if armed.is_err() {
		cx.default_global::<Frames>().armed = None;
	}
}

/// Answers every parked wait whose condition holds, drops the waits of
/// clients that hung up, and re-arms the next frame while an idle wait is
/// left.
fn settle_waits(cx: &mut App) {
	let waits = std::mem::take(&mut cx.default_global::<Frames>().waits);
	let mut parked = Vec::with_capacity(waits.len());
	for wait in waits {
		let reply = match holds(&wait.condition, cx) {
			Ok(true) => protocol::ok(&wait.id),
			Ok(false) if !wait.reply.is_disconnected() => {
				parked.push(wait);
				continue;
			},
			Ok(false) => continue,
			Err(message) => protocol::error(&wait.id, &message),
		};
		wait.reply.send(reply).ok();
	}
	let idle = parked.iter().any(|wait| wait.condition == Condition::Idle);
	cx.default_global::<Frames>().waits.append(&mut parked);
	if idle {
		arm(cx);
	}
}

/// Types `text` one keystroke at a time through the window's key dispatch
/// and its focused input handler, as a keyboard would.
fn type_text(text: &str, window: &mut Window, cx: &mut App) {
	for ch in text.chars() {
		let (key, key_char) = match ch {
			' ' => ("space".to_owned(), Some(" ".to_owned())),
			'\n' => ("enter".to_owned(), None),
			'\t' => ("tab".to_owned(), None),
			ch => (ch.to_lowercase().collect(), Some(ch.to_string())),
		};
		let modifiers = Modifiers { shift: ch.is_uppercase(), ..Modifiers::default() };
		window.dispatch_keystroke(Keystroke { modifiers, key, key_char }, cx);
	}
}

/// The window requests act on: the active one, else the first open one.
fn focused(cx: &App) -> Option<AnyWindowHandle> {
	cx.active_window().or_else(|| cx.windows().first().copied())
}

fn in_window<R>(cx: &mut App, f: impl FnOnce(&mut Window, &mut App) -> R) -> Result<R, String> {
	let window = focused(cx).ok_or_else(no_window)?;
	window
		.update(cx, |_, window, cx| f(window, cx))
		.map_err(|error| error.to_string())
}

/// Reports a painted frame to every subscribed client, and re-checks the
/// parked waits once the frame is presented.
pub(super) fn frame_painted(cx: &mut App) {
	if !cx.has_global::<Frames>() {
		return;
	}
	let t_ns = monotonic_ns();
	let frames = cx.global_mut::<Frames>();
	frames.painted += 1;
	let event = protocol::frame(frames.painted, t_ns);
	frames
		.subscribers
		.retain(|client| client.send(event.clone()).is_ok());
	if !frames.waits.is_empty() {
		// The platform presents a frame in the update that painted it, so
		// an effect deferred from the paint runs after the present.
		cx.defer(settle_waits);
	}
}

/// Nanoseconds on `CLOCK_MONOTONIC`, the clock the bench's fake model stamps
/// its tokens with.
fn monotonic_ns() -> u64 {
	let mut now = libc::timespec { tv_sec: 0, tv_nsec: 0 };
	// SAFETY: `now` is a valid, writable timespec for the whole call.
	let status = unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &raw mut now) };
	if status != 0 {
		return 0;
	}
	u64::try_from(now.tv_sec)
		.unwrap_or(0)
		.saturating_mul(1_000_000_000)
		.saturating_add(u64::try_from(now.tv_nsec).unwrap_or(0))
}
