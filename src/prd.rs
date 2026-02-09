use anyhow::{Context, Result};
use std::{fs, path::Path};

#[derive(Debug, Clone)]
pub struct PrdItem {
    pub text: String,
    pub checked: bool,
}

#[derive(Debug, Clone)]
pub struct PrdDocument {
    pub items: Vec<PrdItem>,
}

impl PrdDocument {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = fs::read_to_string(path)
            .with_context(|| format!("failed to read PRD file {}", path.display()))?;
        Ok(Self::parse(&raw))
    }

    pub fn parse(input: &str) -> Self {
        let mut items = Vec::new();

        for line in input.lines() {
            let trimmed = line.trim_start();
            if let Some(text) = trimmed.strip_prefix("- [ ] ") {
                items.push(PrdItem {
                    text: text.trim().to_string(),
                    checked: false,
                });
            } else if let Some(text) = trimmed
                .strip_prefix("- [x] ")
                .or_else(|| trimmed.strip_prefix("- [X] "))
            {
                items.push(PrdItem {
                    text: text.trim().to_string(),
                    checked: true,
                });
            }
        }

        Self { items }
    }

    pub fn unchecked_items(&self) -> Vec<&PrdItem> {
        self.items.iter().filter(|it| !it.checked).collect()
    }
}

pub fn mark_item_done(path: &Path, target_item: &str) -> Result<bool> {
    let contents = fs::read_to_string(path)
        .with_context(|| format!("failed to read PRD file {}", path.display()))?;
    let mut changed = false;
    let target_norm = normalize(target_item);

    let mut rewritten = Vec::new();
    for line in contents.lines() {
        if changed {
            rewritten.push(line.to_string());
            continue;
        }

        let trimmed = line.trim_start();
        if let Some(text) = trimmed.strip_prefix("- [ ] ") {
            let text_norm = normalize(text);
            if text_norm == target_norm || text_norm.contains(&target_norm) {
                let prefix_len = line.len() - trimmed.len();
                let prefix = &line[..prefix_len];
                rewritten.push(format!("{prefix}- [x] {}", text.trim()));
                changed = true;
                continue;
            }
        }

        rewritten.push(line.to_string());
    }

    if changed {
        let mut output = rewritten.join("\n");
        if contents.ends_with('\n') {
            output.push('\n');
        }
        fs::write(path, output)
            .with_context(|| format!("failed to write PRD file {}", path.display()))?;
    }

    Ok(changed)
}

fn normalize(s: &str) -> String {
    s.trim().to_lowercase()
}
