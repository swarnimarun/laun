import { spawnSync } from "node:child_process";

/**
 * Notify-on-grant watcher: after a denial-shaped tool failure, poll
 * `openshell rule history <sandbox>` for a NEW approved rule and steer the
 * live run to retry. Checked `rule history --help`: no machine format
 * (--json/--format absent), so history is parsed as text lines of the shape
 * `<id> <time> approved [<chunk>] Rule '<name>' approved`.
 */

/** Default watch window: ~90s (a grant arriving later is a new run's job). */
export const DEFAULT_NOTIFY_GRANT_WINDOW_MS = 90_000;
/** Default poll interval: ~10s (grants are human/advisor-paced, not hot). */
export const DEFAULT_NOTIFY_GRANT_POLL_MS = 10_000;
/** Config bounds: small enough for tests, tight enough to stay bounded. */
export const MIN_NOTIFY_GRANT_WINDOW_MS = 100;
export const MAX_NOTIFY_GRANT_WINDOW_MS = 600_000;
export const MIN_NOTIFY_GRANT_POLL_MS = 25;
export const MAX_NOTIFY_GRANT_POLL_MS = 60_000;
/** Explicit bound for one `rule history` spawn (never hang a poll tick). */
export const RULE_HISTORY_TIMEOUT_MS = 10_000;

/**
 * Denial shapes that start a watch. Enumerated outward from the live shape
 * `EACCES 198.18.0.2:443` (sandbox egress refused): the errno, the two
 * policy wordings, the HTTP wording, and proxy-refused variants (proxy +
 * refused/denied/forbidden/blocked/tunnel/403 in either order, plus the
 * ERR_PROXY code). A bare "connection refused" (no proxy/EACCES marker) is
 * deliberately NOT a denial: it is usually a dead listener, not a grantable
 * policy decision. Keep this list tight: every entry is pinned by a test.
 */
const DENIAL_PATTERNS: RegExp[] = [
  /EACCES/,
  /permission denied/i,
  /policy denied/i,
  /\bforbidden\b/i,
  /proxy[^\n]{0,80}\b(refus\w*|denied|forbidden|blocked|tunnel)\b/i,
  /\b(refus\w*|denied|forbidden|blocked)[^\n]{0,80}proxy/i,
  /proxy[^\n]{0,80}\b403\b/i,
  /\b403\b[^\n]{0,80}proxy/i,
  /ERR_PROXY/,
  /proxy[^\n]{0,80}\btunnel\b/i,
  /\btunnel\b[^\n]{0,80}proxy/i,
];

/**
 * True when a failed tool result looks like a grantable network denial.
 * Never throws; empty/missing output is not a denial.
 */
export function isDenialOutput(output?: string): boolean {
  if (!output) return false;
  for (const re of DENIAL_PATTERNS) {
    try {
      if (re.test(output)) return true;
    } catch {
      // a bad pattern must never break a run; try the rest
    }
  }
  return false;
}

/**
 * Parse `openshell rule history <sandbox>` text into approved rule names.
 * Accepts the live-observed line shape (id + timestamp + "approved", an
 * optional "[chunk ...]" segment, then "Rule '<name>' approved") and
 * ignores everything else (pending/rejected rows, headers, garbage).
 * Single- and double-quoted names both parse; the name is trimmed and
 * empty names are dropped. Never throws.
 */
export function parseRuleHistory(output: string): string[] {
  const names: string[] = [];
  try {
    if (!output) return names;
    for (const line of output.split("\n")) {
      if (!/approved/i.test(line)) continue;
      const m = line.match(/Rule\s+['"]([^'"]+)['"]/);
      if (!m) continue;
      const name = (m[1] ?? "").trim();
      if (name) names.push(name);
    }
  } catch {
    // parse must never throw on gateway text
  }
  return names;
}

/** Exact `rule history` argv shaping (no shell, no invented flags). */
export function buildGrantHistoryArgs(sandboxName: string): string[] {
  return ["rule", "history", sandboxName];
}

/** Steer + note text for a fresh grant (rule name interpolated, bounded). */
export function buildNotifySteerMessage(rule: string): string {
  const name = (rule || "").trim().slice(0, 200) || "unknown";
  return `Network access granted (${name}) — retry your last blocked command.`;
}

/**
 * One history fetch via the openshell CLI (spawnSync, explicit timeout).
 * Returns approved rule names; returns [] when the CLI is missing, times
 * out, exits nonzero, or prints unparsable text. Never throws: a failed
 * poll keeps the watch alive until the window expires.
 */
export function fetchGrantHistorySync(bin: string, sandboxName: string, timeoutMs: number = RULE_HISTORY_TIMEOUT_MS): string[] {
  try {
    const r = spawnSync(bin, buildGrantHistoryArgs(sandboxName), { encoding: "utf8", timeout: timeoutMs });
    if (r.error) return [];
    if (r.status !== 0) return [];
    return parseRuleHistory(r.stdout ?? "");
  } catch {
    return [];
  }
}
