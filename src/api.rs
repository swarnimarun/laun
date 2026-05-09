use anyhow::{Context, Result};
use reqwest::Client;
use serde::Serialize;
use serde_json::Value;

use crate::config::ApiConfig;
use crate::tools::{Tool, ToolCall, ToolFunction};

#[derive(Debug, Clone, Serialize)]
pub struct ChatMessage {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ChatResponse {
    pub content: Option<String>,
    pub tool_calls: Vec<ToolCall>,
}

pub struct ApiClient {
    pub client: Client,
    pub config: ApiConfig,
}

impl ApiClient {
    pub fn new(config: ApiConfig) -> Result<Self> {
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .context("failed to create HTTP client")?;
        Ok(Self { client, config })
    }

    pub fn chat_url(&self) -> String {
        format!(
            "{}/chat/completions",
            self.config.base_url.trim_end_matches('/')
        )
    }

    pub fn auth_header(&self) -> String {
        format!("Bearer {}", self.config.api_key)
    }

    pub async fn chat_stream(
        &self,
        messages: &[ChatMessage],
        tools: &[Tool],
    ) -> Result<ChatResponse> {
        use futures::StreamExt;

        let body = serde_json::json!({
            "model": self.config.model,
            "messages": messages,
            "tools": tools,
            "tool_choice": "auto",
            "temperature": self.config.temperature,
            "max_tokens": self.config.max_tokens,
            "stream": true,
        });

        let resp = self
            .client
            .post(self.chat_url())
            .header("Authorization", self.auth_header())
            .json(&body)
            .send()
            .await
            .context("API streaming call failed")?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("API error ({status}): {}", truncate(&text, 500));
        }

        let mut stream = resp.bytes_stream();
        let mut full_content = String::new();
        let mut tool_call_builders: Vec<ToolCallBuilder> = Vec::new();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("stream read error")?;
            let text = String::from_utf8_lossy(&chunk);

            for line in text.lines() {
                let line = line.trim();
                if line.is_empty() || line == "data: [DONE]" {
                    continue;
                }
                let json_str = line.strip_prefix("data: ").unwrap_or(line);
                if let Ok(parsed) = serde_json::from_str::<Value>(json_str) {
                    if let Some(choices) = parsed["choices"].as_array() {
                        for choice in choices {
                            let delta = &choice["delta"];

                            if let Some(c) = delta["content"].as_str() {
                                full_content.push_str(c);
                            }

                            if let Some(tc_deltas) = delta["tool_calls"].as_array() {
                                for tc in tc_deltas {
                                    let index = tc["index"].as_u64().unwrap_or(0) as usize;
                                    while tool_call_builders.len() <= index {
                                        tool_call_builders.push(ToolCallBuilder::default());
                                    }
                                    let builder = &mut tool_call_builders[index];

                                    if let Some(id) = tc["id"].as_str() {
                                        builder.id = Some(id.to_string());
                                    }
                                    if let Some(name) = tc["function"]["name"].as_str() {
                                        builder.name = Some(name.to_string());
                                    }
                                    if let Some(args) = tc["function"]["arguments"].as_str() {
                                        builder.arguments.push_str(args);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        let tool_calls: Vec<ToolCall> = tool_call_builders
            .into_iter()
            .filter_map(|b| b.build())
            .collect();

        let content = if full_content.is_empty() {
            None
        } else {
            Some(full_content)
        };

        Ok(ChatResponse {
            content,
            tool_calls,
        })
    }
}

#[derive(Debug, Default)]
struct ToolCallBuilder {
    id: Option<String>,
    name: Option<String>,
    arguments: String,
}

impl ToolCallBuilder {
    fn build(self) -> Option<ToolCall> {
        let id = self.id?;
        let name = self.name?;
        let arguments = if self.arguments.is_empty() {
            "{}".to_string()
        } else {
            self.arguments
        };
        Some(ToolCall {
            id,
            call_type: "function".to_string(),
            function: ToolFunction { name, arguments },
        })
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}...", &s[..max])
    }
}
