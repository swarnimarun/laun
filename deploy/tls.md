# TLS upgrade path (Caddy in front of the gateway)

The SSH tunnel stays the default. Use this page only when you want the
gateway reachable at `https://<your-domain>` instead of through a tunnel.

Caddy terminates TLS and reverse-proxies **only the gateway** (`:8080`).
The executor (`:8081`) is never exposed — loopback-only, no route for it.

## Prerequisites

- A domain with an **A record pointing at the VPS** (e.g. `laun.example.com`
  → the VPS public IP). Wait for DNS to propagate (`dig +short` shows the IP).
- **TCP 80 + 443 reachable**: allow them in the provider firewall/security
  list AND in `ufw` on the box (`sudo ufw allow 80,443/tcp`). Ports 80 (ACME
  HTTP challenge) and 443 (HTTPS) are both required.
- The tunnel path keeps working — direct access over it stays valid as a
  fallback while you cut over.

## Enable

1. Set the two placeholders in the remote `.env` (real values live only in
   `.env`, never in this repo):

   ```bash
   DOMAIN=laun.example.com
   ACME_EMAIL=you@example.com
   ```

   (`DOMAIN` is the hostname Caddy gets a cert for; `ACME_EMAIL` is the
   Let's Encrypt contact for expiry/issue notices.)

2. Uncomment the `caddy` service block in `deploy/docker-compose.yml`
   (it is commented out by default).

3. Bring the stack up and check the logs:

   ```bash
   cd /opt/laun && sudo docker compose -f deploy/docker-compose.yml --env-file .env up -d --build caddy
   sudo docker compose -f deploy/docker-compose.yml --env-file .env logs caddy   # look for "certificate obtained"
   ```

4. Verify:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://<your-domain>/health
   curl -s -I http://<your-domain> | grep -i location   # HTTP→HTTPS redirect
   ```

## Notes

- `deploy/Caddyfile` is the whole recipe: every block says why it exists.
  The `{$DOMAIN}` / `{$ACME_EMAIL}` placeholders are Caddy env syntax —
  they resolve from the container environment at startup.
- Renewal is automatic (Caddy handles ACME refresh). If issuance fails,
  `docker compose logs caddy` names the cause (usually DNS or port 80).
- To go back to tunnel-only: stop the `caddy` service, re-comment its
  block, and close 80/443.
