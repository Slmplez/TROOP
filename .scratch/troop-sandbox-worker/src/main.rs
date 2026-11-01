// THROWAWAY Linux Worker. Model orchestration remains in the host Rust Core.
#[cfg(unix)] mod linux;
fn main() {
    #[cfg(unix)] linux::main();
    #[cfg(not(unix))] { eprintln!("This prototype requires a Linux container; host execution is disabled."); std::process::exit(78); }
}
