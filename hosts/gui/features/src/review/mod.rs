//! Review surface components: comment threads, reply composer, and change
//! requests.

pub mod change_request;
pub mod composer;
pub mod logic;
pub mod thread;

pub use change_request::render_change_request_card;
pub use composer::render_new_thread_composer;
pub use thread::render_thread_card;

#[cfg(test)]
mod tests;
