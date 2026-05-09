use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use crossterm::{
    event::{self, Event, KeyCode, KeyEventKind},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{
    prelude::*,
    widgets::*,
};

use crate::config::Config;
use crate::goal::{self, GoalState, SharedState, StateHandle, StreamLine};

pub async fn start(goal_text: String, config: Config) -> Result<()> {
    enable_raw_mode()?;
    let mut stdout = std::io::stdout();
    execute!(stdout, EnterAlternateScreen)?;

    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let state: StateHandle = Arc::new(Mutex::new(SharedState::new(
        goal_text.clone(),
        config.goal.max_iterations,
        config.api.model.clone(),
    )));

    let agent_state = state.clone();
    let agent_config = config.clone();
    let agent_handle = tokio::spawn(async move {
        let s = agent_state.clone();
        if let Err(err) = crate::agent::run_loop(agent_state, agent_config).await {
            if let Ok(mut s) = s.lock() {
                if s.goal_state != GoalState::Completed {
                    s.goal_state = GoalState::Failed;
                    s.error_message = Some(format!("{err:#}"));
                }
            }
        }
    });

    let start_time = Instant::now();
    let mut should_quit = false;
    let mut stream_offset: usize = 0;

    loop {
        while event::poll(Duration::from_millis(16)).unwrap_or(false) {
            if let Ok(Event::Key(key)) = event::read() {
                if key.kind == KeyEventKind::Press {
                    match key.code {
                        KeyCode::Char('q') => {
                            should_quit = true;
                            if let Ok(mut s) = state.lock() {
                                if s.goal_state == GoalState::Running
                                    || s.goal_state == GoalState::Paused
                                {
                                    s.goal_state = GoalState::Failed;
                                    s.error_message = Some("User quit".into());
                                }
                            }
                        }
                        KeyCode::Char('p') | KeyCode::Char(' ') => {
                            if let Ok(mut s) = state.lock() {
                                if s.goal_state == GoalState::Running {
                                    s.goal_state = GoalState::Paused;
                                } else if s.goal_state == GoalState::Paused {
                                    s.goal_state = GoalState::Running;
                                }
                            }
                        }
                        KeyCode::Char('j') | KeyCode::Down => {
                            stream_offset = stream_offset.saturating_add(1);
                        }
                        KeyCode::Char('k') | KeyCode::Up => {
                            stream_offset = stream_offset.saturating_sub(1);
                        }
                        KeyCode::Char('g') => {
                            stream_offset = 0;
                        }
                        KeyCode::Char('G') => {
                            if let Ok(s) = state.lock() {
                                stream_offset = s.stream_lines.len().saturating_sub(1);
                            }
                        }
                        _ => {}
                    }
                }
            }
        }

        if should_quit {
            break;
        }

        terminal.draw(|frame| {
            render(frame, &state.lock().unwrap(), start_time.elapsed(), &mut stream_offset);
        })?;
    }

    agent_handle.abort();
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;

    print_final_summary(&state);

    Ok(())
}

fn print_final_summary(state: &StateHandle) {
    let s = state.lock().unwrap();
    println!();
    match s.goal_state {
        GoalState::Completed => {
            println!("Goal completed!");
            if let Some(ref summary) = s.finish_summary {
                println!("  {summary}");
            }
        }
        GoalState::Failed => {
            println!("Goal did not complete.");
            if let Some(ref err) = s.error_message {
                println!("  {err}");
            }
        }
        _ => println!("Laun exited."),
    }
    println!("  Turns: {}/{}", s.iteration, s.max_iterations);
    println!("  Tool calls: {}", s.tool_call_count);
    println!(
        "  Checkpoints: {}",
        s.progress_log.checkpoints.len()
    );
}

fn render(
    frame: &mut Frame,
    state: &SharedState,
    elapsed: Duration,
    stream_offset: &mut usize,
) {
    let area = frame.area();

    if area.height < 8 {
        let text = Text::from("Terminal too small (min 8 lines).");
        frame.render_widget(
            Paragraph::new(text).style(Style::default().fg(Color::Red)),
            area,
        );
        return;
    }

    let layout = Layout::vertical([
        Constraint::Length(4),
        Constraint::Percentage(30),
        Constraint::Min(3),
        Constraint::Length(1),
    ])
    .split(area);

    render_goal_panel(frame, layout[0], state, elapsed);
    render_progress_panel(frame, layout[1], state);
    render_agent_panel(frame, layout[2], state, stream_offset);
    render_status_bar(frame, layout[3], state, stream_offset);
}

fn render_goal_panel(frame: &mut Frame, area: Rect, state: &SharedState, elapsed: Duration) {
    let state_color = match state.goal_state {
        GoalState::Running => Color::Green,
        GoalState::Paused => Color::Yellow,
        GoalState::Completed => Color::Cyan,
        GoalState::Failed => Color::Red,
        GoalState::Idle => Color::Gray,
    };

    let title = format!(
        " Goal — {} — turn {}/{} — {}s ",
        goal::state_label(&state.goal_state),
        state.iteration,
        state.max_iterations,
        elapsed.as_secs()
    );

    let block = Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(state_color))
        .title_style(Style::default().fg(state_color).add_modifier(Modifier::BOLD));

    let width = area.width.saturating_sub(4) as usize;
    let wrapped_goal = textwrap::fill(&state.goal_text, width.max(20));

    let lines = vec![
        Line::from(vec![Span::styled(
            &state.model,
            Style::default().fg(Color::DarkGray),
        )]),
        Line::from(""),
        Line::from(vec![Span::styled(
            wrapped_goal,
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        )]),
    ];

    let paragraph = Paragraph::new(Text::from(lines)).block(block);
    frame.render_widget(paragraph, area);
}

fn render_progress_panel(frame: &mut Frame, area: Rect, state: &SharedState) {
    let mut lines: Vec<Line> = Vec::new();

    if state.progress_log.checkpoints.is_empty() {
        lines.push(Line::from(vec![Span::styled(
            " No checkpoints yet...",
            Style::default().fg(Color::DarkGray),
        )]));
    } else {
        let visible_count = (area.height as usize).saturating_sub(2);
        let visible = state
            .progress_log
            .checkpoints
            .iter()
            .rev()
            .take(visible_count);

        for cp in visible {
            let (icon, color) = if cp.validation_pass {
                ("✓", Color::Green)
            } else {
                ("✗", Color::Red)
            };
            lines.push(Line::from(vec![
                Span::styled(format!(" {icon}  "), Style::default().fg(color)),
                Span::styled(
                    format!("CP{}: {}", cp.number, cp.description),
                    Style::default().fg(Color::Gray),
                ),
            ]));
        }
    }

    let block = Block::default()
        .title(" Progress Log ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::DarkGray));

    let paragraph = Paragraph::new(Text::from(lines)).block(block);
    frame.render_widget(paragraph, area);
}

fn render_agent_panel(
    frame: &mut Frame,
    area: Rect,
    state: &SharedState,
    stream_offset: &mut usize,
) {
    let max_visible = (area.height as usize).saturating_sub(3);
    if max_visible == 0 {
        return;
    }

    let total_lines = state.stream_lines.len();
    let max_offset = total_lines.saturating_sub(max_visible);
    if *stream_offset > max_offset {
        *stream_offset = max_offset;
    }

    let visible: Vec<&StreamLine> = state
        .stream_lines
        .iter()
        .skip(*stream_offset)
        .take(max_visible)
        .collect();

    let width = area.width.saturating_sub(4) as usize;
    let mut lines: Vec<Line> = Vec::new();

    for sl in visible {
        let (prefix, content, color) = match sl {
            StreamLine::Thinking(text) => ("*", text.as_str(), Color::Cyan),
            StreamLine::Action(text) => (">", text.as_str(), Color::Yellow),
            StreamLine::ToolResult(text) => (" ", text.as_str(), Color::Green),
            StreamLine::Info(text) => ("i", text.as_str(), Color::DarkGray),
            StreamLine::Validation(text) => ("v", text.as_str(), Color::Blue),
            StreamLine::Error(text) => ("!", text.as_str(), Color::Red),
            StreamLine::Done(text) => ("*", text.as_str(), Color::Magenta),
        };

        let wrapped = textwrap::fill(content, width.max(20));
        for wline in wrapped.lines() {
            lines.push(Line::from(vec![
                Span::styled(format!(" {prefix}  "), Style::default().fg(color)),
                Span::styled(wline.to_string(), Style::default().fg(Color::White)),
            ]));
        }
    }

    let title = format!(
        " Agent Stream [{} lines, @{}/{}] ",
        total_lines,
        stream_offset,
        max_offset
    );

    let block = Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::DarkGray));

    let paragraph = Paragraph::new(Text::from(lines)).block(block);
    frame.render_widget(paragraph, area);
}

fn render_status_bar(
    frame: &mut Frame,
    area: Rect,
    state: &SharedState,
    stream_offset: &usize,
) {
    let status_text = match state.goal_state {
        GoalState::Idle => "IDLE — Press any key to start".into(),
        GoalState::Running => format!(
            "RUNNING | tools:{} | q:quit p:pause j/k:scroll",
            state.tool_call_count
        ),
        GoalState::Paused => "PAUSED — p:resume q:quit".into(),
        GoalState::Completed => "COMPLETED — q:quit".into(),
        GoalState::Failed => "FAILED — q:quit".into(),
    };

    let _ = stream_offset;

    let style = match state.goal_state {
        GoalState::Running => Style::default()
            .fg(Color::Black)
            .bg(Color::Green)
            .add_modifier(Modifier::BOLD),
        GoalState::Paused => Style::default()
            .fg(Color::Black)
            .bg(Color::Yellow)
            .add_modifier(Modifier::BOLD),
        GoalState::Completed => Style::default()
            .fg(Color::Black)
            .bg(Color::Cyan)
            .add_modifier(Modifier::BOLD),
        GoalState::Failed => Style::default()
            .fg(Color::White)
            .bg(Color::Red)
            .add_modifier(Modifier::BOLD),
        GoalState::Idle => Style::default().fg(Color::DarkGray).bg(Color::Black),
    };

    let span = Span::styled(
        textwrap::fill(&status_text, (area.width as usize).saturating_sub(2)),
        style,
    );

    let paragraph = Paragraph::new(Line::from(span));
    frame.render_widget(paragraph, area);
}
