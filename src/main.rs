mod api;
mod agent;
mod cli;
mod config;
mod goal;
mod tools;
mod tui;

#[tokio::main]
async fn main() {
    if let Err(err) = cli::run().await {
        eprintln!("error: {err:#}");
        std::process::exit(1);
    }
}
