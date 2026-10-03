import type { AgentEvent, ExecutorRunRequest } from "@cloudbear/protocol";

/** POSTs a run to the executor and yields AgentEvents from the NDJSON stream. */
export async function* streamExecutorRun(
  executorUrl: string,
  token: string,
  req: ExecutorRunRequest,
): AsyncGenerator<AgentEvent> {
  const res = await fetch(`${executorUrl}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new Error(`executor ${res.status}: ${detail.slice(0, 300)}`);
  }
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const ev = parseEventLine(line);
      if (ev) yield ev;
    }
  }
  const tail = (buf + decoder.decode()).trim();
  if (tail) {
    const ev = parseEventLine(tail);
    if (ev) yield ev;
  }
}

function parseEventLine(line: string): AgentEvent | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const obj = JSON.parse(t) as AgentEvent;
    if (obj && typeof obj === "object" && typeof obj.type === "string" && typeof obj.sessionId === "string") {
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}
