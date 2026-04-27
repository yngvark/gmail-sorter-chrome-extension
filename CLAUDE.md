# Project instructions

## Local HTTP server

Use `bin/serve` to serve the `extension/` directory over HTTP for browser-based UI verification (Playwright file:// is blocked, ES module imports need an HTTP origin).

- ❌ Never launch an HTTP server directly (e.g. `python3 -m http.server`).
- ✅ Always use `bin/serve` — it manages PID/port files in `.scratch/` and replaces any prior instance.

Run `bin/serve --help` for usage.
