//! Stateful headless session driving a window across keystrokes, clicks and
//! renders.
//!
//! While [`crate::headless::render_view_captured`] opens, renders and tears
//! down a window in one shot, a test of user interaction requires the window
//! and its view entity to persist across multiple frames, clock ticks and input
//! events.
//!
//! [`HeadlessSession`] wraps an open window handle, sets up focus and scale
//! factor, and keeps the window alive until dropped.

use std::time::Duration;

use veyyon_gpui::{
	App, Context, Entity, Keystroke, Modifiers, MouseButton, MouseDownEvent, MouseUpEvent, Pixels,
	PlatformInput, Point, Render, Window, WindowHandle,
};

use crate::headless::{Captured, Headless, RenderError, RenderOptions, capture_window};

/// A live headless window session for multi-step interaction testing.
///
/// Holds a reference to the process-wide [`Headless`] context permit and an
/// open [`WindowHandle`], dispatching input events and capturing rendered
/// frames without destroying the window between operations.
pub struct HeadlessSession<'a, V: 'static> {
	cx:      &'a mut Headless,
	window:  WindowHandle<V>,
	root:    Entity<V>,
	options: RenderOptions,
}

impl<'a, V: Render + 'static> HeadlessSession<'a, V> {
	/// Opens a new headless window session with the given options and root view
	/// constructor.
	///
	/// Activates the window, applies the scale factor, and renders an initial
	/// frame so interactive elements and input handlers are registered.
	pub fn open(
		cx: &'a mut Headless,
		options: &RenderOptions,
		build_root: impl FnOnce(&mut Window, &mut App) -> Entity<V>,
	) -> Result<Self, RenderError> {
		let mut root_slot = None;
		let window = cx
			.open_window(options.logical_size(), |window, app| {
				let entity = build_root(window, app);
				root_slot = Some(entity.clone());
				entity
			})
			.map_err(|error| RenderError::NoFrame { message: format!("{error:?}") })?;

		let root = root_slot.ok_or_else(|| RenderError::NoFrame {
			message: "root view was not created during window open".to_string(),
		})?;

		cx.update_window(window.into(), |_, window, _| {
			window.set_scale_factor(options.scale_factor);
			window.activate_window();
		})
		.map_err(|error| RenderError::NoFrame { message: format!("{error:?}") })?;

		cx.run_until_parked();

		// Render initial frame to register input handlers and paint bounds
		let _ = cx
			.update_window(window.into(), |_, window, _| window.render_to_frame(options.scale_factor))
			.map_err(|error| RenderError::NoFrame { message: format!("{error:?}") })?;

		cx.run_until_parked();

		Ok(Self { cx, window, root, options: *options })
	}

	/// Returns the root view entity handle for this window.
	#[must_use]
	pub fn root(&self) -> Entity<V> {
		self.root.clone()
	}

	/// Delivers the next frame to the window and captures its pixels, layout box
	/// tree and hitboxes.
	///
	/// This is one vsync: pending animation callbacks run and the window draws
	/// if it is dirty, so a transition or a spring advances by however far
	/// [`advance`](Self::advance) moved the clock. A window with nothing pending
	/// draws nothing, and the capture is the frame already on screen.
	pub fn frame(&mut self) -> Result<Captured, RenderError> {
		self.cx.run_until_parked();
		self
			.cx
			.request_frame(self.window.into())
			.map_err(|error| RenderError::NoFrame { message: format!("{error:?}") })?;
		self.cx.run_until_parked();
		capture_window(self.cx, self.window.into(), self.options.scale_factor)
	}

	/// Dispatches a single keystroke chord (such as `"cmd-k"`, `"enter"`, or
	/// `"a"`).
	///
	/// Returns whether the keystroke was handled by an active action or input
	/// handler.
	pub fn keystroke(&mut self, chord: &str) -> Result<bool, RenderError> {
		let keystroke = Keystroke::parse(chord).map_err(|error| RenderError::InvalidKeystroke {
			chord:   chord.to_string(),
			message: format!("{error:?}"),
		})?;

		let handled = self
			.cx
			.update_window(self.window.into(), |_, window, cx| {
				window.dispatch_keystroke(keystroke, cx)
			})
			.map_err(|error| RenderError::Window { message: format!("{error:?}") })?;

		self.cx.run_until_parked();
		Ok(handled)
	}

	/// Types a string of text sequentially into the focused input element.
	pub fn type_text(&mut self, text: &str) -> Result<(), RenderError> {
		for ch in text.chars() {
			let s = ch.to_string();
			let keystroke = Keystroke {
				modifiers: if ch.is_uppercase() {
					Modifiers { shift: true, ..Default::default() }
				} else {
					Modifiers::default()
				},
				key:       match ch {
					'\n' => "enter".to_string(),
					'\t' => "tab".to_string(),
					' ' => "space".to_string(),
					c if c.is_uppercase() => s.to_lowercase(),
					_ => s.clone(),
				},
				key_char:  Some(s),
			};

			let _ = self
				.cx
				.update_window(self.window.into(), |_, window, cx| {
					window.dispatch_keystroke(keystroke, cx)
				})
				.map_err(|error| RenderError::Window { message: format!("{error:?}") })?;
		}

		self.cx.run_until_parked();
		Ok(())
	}

	/// Dispatches a mouse click (`MouseDown` followed by `MouseUp`) at the given
	/// logical coordinates.
	pub fn click(&mut self, at: Point<Pixels>) -> Result<(), RenderError> {
		let mouse_down = PlatformInput::MouseDown(MouseDownEvent {
			button:      MouseButton::Left,
			position:    at,
			modifiers:   Modifiers::default(),
			click_count: 1,
			first_mouse: false,
		});

		let mouse_up = PlatformInput::MouseUp(MouseUpEvent {
			button:      MouseButton::Left,
			position:    at,
			modifiers:   Modifiers::default(),
			click_count: 1,
		});

		self
			.cx
			.update_window(self.window.into(), |_, window, cx| {
				window.dispatch_event(mouse_down, cx);
				window.dispatch_event(mouse_up, cx);
			})
			.map_err(|error| RenderError::Window { message: format!("{error:?}") })?;

		self.cx.run_until_parked();
		Ok(())
	}

	/// Advances the simulated clock by the specified duration and processes
	/// pending timers.
	pub fn advance(&mut self, by: Duration) {
		self.cx.advance_clock(by);
		self.cx.run_until_parked();
	}

	/// Mutates the root view and window state within a closure.
	pub fn update<R>(
		&mut self,
		f: impl FnOnce(&mut V, &mut Window, &mut Context<V>) -> R,
	) -> Result<R, RenderError> {
		let result = self
			.window
			.update(&mut **self.cx, f)
			.map_err(|error| RenderError::Window { message: format!("{error:?}") })?;

		self.cx.run_until_parked();
		Ok(result)
	}
}

impl<V: 'static> Drop for HeadlessSession<'_, V> {
	fn drop(&mut self) {
		let window = self.window;
		self.cx.update(|app| {
			let _ = window.update(app, |_, window, _| window.remove_window());
		});
	}
}
