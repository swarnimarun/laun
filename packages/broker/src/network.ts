import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export interface PinnedEndpoint { url: URL; address: string; family: 4 | 6; }
export interface HttpReply { status: number; contentType: string; sessionId?: string; body: string; }

export function isLoopback(address: string): boolean {
  if (isIP(address) === 4) return Number(address.split(".")[0]) === 127;
  return address.toLowerCase() === "::1";
}

export function isPublicAddress(address: string): boolean {
  let ip = address.toLowerCase();
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)) return false;
    return true;
  }
  // Global unicast only: excludes loopback, link-local, ULA, multicast, mapped
  // IPv4 and special translation ranges, which must not bypass the v4 check.
  if (isIP(ip) !== 6) return false;
  ip = new URL(`http://[${ip}]`).hostname.slice(1, -1);
  const [first, second] = ip.split(":").map((part) => parseInt(part || "0", 16));
  return /^[23][0-9a-f]{0,3}:/.test(ip) && first !== 0x2002 &&
    !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
}

/** Resolve once and pin the actual socket lookup; checking DNS then fetch is unsafe. */
export async function pinEndpoint(raw: string, loopbackAllowed: boolean, signal?: AbortSignal): Promise<PinnedEndpoint> {
  signal?.throwIfAborted();
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("connector endpoint must be a valid URL"); }
  if (url.username || url.password || url.hash) throw new Error("connector endpoint must not contain credentials or a fragment");
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("connector endpoint must use HTTPS");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(host);
  const addresses = literal ? [{ address: host, family: literal }] : await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
    const aborted = () => finish(new Error("connector DNS cancelled"));
    const timer = setTimeout(() => finish(new Error("connector DNS timeout")), 5_000); timer.unref();
    const finish = (error?: Error, value?: Array<{ address: string; family: number }>) => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); if (error) reject(error); else resolve(value!); };
    signal?.addEventListener("abort", aborted, { once: true });
    lookup(host, { all: true, verbatim: true }).then((value) => finish(undefined, value), (error) => finish(error));
    if (signal?.aborted) aborted();
  });
  signal?.throwIfAborted();
  if (addresses.length === 0 || addresses.length > 64) throw new Error("connector endpoint has no usable address");
  const local = loopbackAllowed && addresses.every((item) => isLoopback(item.address));
  if (!local && addresses.some((item) => !isPublicAddress(item.address))) throw new Error("connector endpoint resolves to a private or reserved address");
  if (url.protocol !== "https:" && !local) throw new Error("remote connector endpoint must use HTTPS");
  return { url, address: addresses[0]!.address, family: addresses[0]!.family as 4 | 6 };
}

/** No redirect following; the original TLS hostname remains intact with pinned DNS. */
export async function postPinned(
  endpoint: PinnedEndpoint, body: string | undefined, headers: Record<string, string>,
  options: { timeoutMs: number; maxBytes: number; method?: "POST" | "DELETE"; signal?: AbortSignal },
): Promise<HttpReply> {
  options.signal?.throwIfAborted();
  return await new Promise<HttpReply>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: HttpReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", aborted);
      if (error) reject(error); else resolve(result!);
    };
    const request = (endpoint.url.protocol === "https:" ? httpsRequest : httpRequest)(endpoint.url, {
      method: options.method ?? "POST", headers: { ...headers, ...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}) },
      // Preserve endpoint hostname for Host/SNI/cert verification while preventing
      // a second resolver lookup from redirecting an approved host to metadata.
      lookup: ((_host: string, opts: { all?: boolean }, callback: (...args: unknown[]) => void) => {
        if (opts?.all) callback(null, [{ address: endpoint.address, family: endpoint.family }]);
        else callback(null, endpoint.address, endpoint.family);
      }) as never,
      agent: false,
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        response.destroy();
        finish(new Error("connector redirects are forbidden; register the destination explicitly"));
        return;
      }
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let bytes = 0;
      let output = "";
      response.on("data", (chunk: Buffer) => {
        if (settled) return;
        try {
          bytes += chunk.byteLength;
          if (bytes > options.maxBytes) throw new Error("connector response byte limit exceeded");
          output += decoder.decode(chunk, { stream: true });
        } catch (error) {
          finish(error as Error); response.destroy(); request.destroy();
        }
      });
      response.on("end", () => {
        try {
          output += decoder.decode();
          const session = response.headers["mcp-session-id"];
          finish(undefined, { status, body: output, contentType: String(response.headers["content-type"] ?? ""),
            ...(typeof session === "string" ? { sessionId: session } : {}) });
        } catch (error) { finish(error as Error); }
      });
      response.on("error", () => finish(new Error("connector response interrupted; outcome may be unknown")));
      response.on("aborted", () => finish(new Error("connector response interrupted; outcome may be unknown")));
    });
    const timer = setTimeout(() => { finish(new Error("connector deadline exceeded; outcome may be unknown")); request.destroy(); }, options.timeoutMs);
    timer.unref();
    const aborted = () => { finish(new Error("connector request cancelled; outcome may be unknown")); request.destroy(); };
    options.signal?.addEventListener("abort", aborted, { once: true });
    request.on("error", () => finish(new Error("connector transport failed; outcome may be unknown")));
    if (options.signal?.aborted) { aborted(); return; }
    if (body) request.write(body);
    request.end();
  });
}
