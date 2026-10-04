/**
 * Bun's HTTP server times a connection out after **10 seconds of inactivity**
 * by default (`ServeOptions.idleTimeout`, documented default `10`), and closes
 * it abruptly rather than completing the response.
 *
 * That is fatal for this service, which streams responses that are silent for
 * long stretches:
 *   - `POST /run` writes nothing while a blocking tool (sleep, install, build)
 *     runs, so the response died ~10s into the tool with
 *     `curl: (18) transfer closed with outstanding read data remaining`, taking
 *     every terminal status event with it and leaving the run invisible to the
 *     gateway.
 *   - the gateway's SSE emits a heartbeat every 15s, which is *slower* than the
 *     default timeout, so SSE would be killed too.
 *
 * `idleTimeout: 0` disables the timeout. Keep this in one exported object so
 * both servers share the value and it stays testable — see serve.test.ts, which
 * asserts a real connection survives longer than the default window.
 */
export const STREAMING_SERVE_OPTIONS = {
  idleTimeout: 0,
} as const;
