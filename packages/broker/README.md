# Laun tool broker

The controller injects authentication/authorization, connector persistence and
credential-reference resolution. The broker never accepts a model-provided grant
or credential value as authority. It supports explicit MCP HTTP revisions
`2026-07-28` (default) and `2025-11-25` (legacy initialization). It does not
silently retry a failed mutation, downgrade the protocol, or respond to remote
sampling, elicitation or roots requests.

Discovery needs a `network.connect` decision on the exact endpoint origin.
Invocation needs both `mcp.invoke` on the discovered immutable tool resource and
`network.connect` on its endpoint. The supplied authorizer must check current
principal, profile, ancestor, run-generation and lease state. It may await a
server-owned approval; this library does not persist or consume grants itself.

Each tool resource includes a SHA-256 of its complete definition, endpoint and
protocol. The runtime must supply the discovered schema digest when invoking.
Changing a description, schema, endpoint or protocol invalidates prior catalog
identity. Arguments are canonical JSON with a bounded byte/depth budget. MCP
servers validate their own JSON Schema; a matching catalog digest does not turn
a tool description or schema annotation into trusted semantics.

HTTP requests pin checked DNS answers to the socket, preserve original TLS
hostname verification, reject redirects and bound deadlines/response bytes.
Private/reserved addresses are denied. Development loopback HTTP requires both
a controller exception and a connector exception; this never permits metadata
or RFC1918 destinations. Tool credentials are resolved after authorization,
used only in the Authorization header, and exact echoed values are redacted
from results. This redaction is defense in depth, not proof against malicious
secret transformations.

Modern transport includes per-request metadata, required method/name headers,
nested statically-reachable `x-mcp-header` parameters and JSON/SSE responses.
Invalid parameter-header tools are excluded during discovery. Legacy mode
performs a fresh initialized session and ends it after the operation. There is
no standalone SSE subscription or automatic tool-list refresh during a call.
An unsupported server interaction fails visibly; external results can remain
uncertain after timeout and must not be blindly retried.

Executable stdio plugins are deliberately unavailable in this controller
package: a future declared plugin process must use a sandbox adapter. Static
HTTP MCP connections are the supported connector installation unit. Installing
one does not grant its tools authority.

`proposePermissionChange` is a deterministic adviser primitive that returns an
unapplied `ask` revision and a feedback question. It cannot override explicit
denies, write policy or approve an action. The controller can use it in its
permission adviser thread; application remains a separate authorized action.

Run `bun test packages/broker/src` from the repository and include this package
in the root TypeScript build. Fixtures run actual local MCP HTTP servers, with
no provider keys or internet calls.

Protocol sources inspected 2026-11-14:
[modern HTTP transport](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx),
[versioning](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/versioning.mdx),
[tools](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/tools.mdx).
