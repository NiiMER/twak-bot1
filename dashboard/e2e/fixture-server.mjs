import { createServer } from "node:http";

// A stand-in for the live agent's snapshot endpoint.
//
// The dashboard reads PLIMSOLL_SNAPSHOT_URL server-side on every request (the
// page is force-dynamic, the fetch is cache: "no-store"). Pointing that at this
// server lets the e2e suite drive the REAL Next app through real agent states —
// veto, kill-switch, blind signals — over the real code path, instead of
// stubbing the page's data layer and testing a fiction.
//
//   GET  /snapshot  → the snapshot currently staged
//   PUT  /snapshot  → stage a new one (what tests call between navigations)
//   GET  /health    → readiness, so Playwright knows the server is up
//
// State is in-memory and shared, which is exactly why the suite runs with
// workers: 1 — see playwright.config.ts.

const PORT = Number(process.env.FIXTURE_PORT ?? 3941);

// Minimal but complete enough to render; tests PUT a real fixture before
// asserting anything, so this only has to keep the server healthy at boot.
let current = { agent: { name: "PLIMSOLL", mode: "dev" } };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 5_000_000) reject(new Error("payload too large"));
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];

  if (url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end('{"ok":true}');
  }

  if (url === "/snapshot" && req.method === "PUT") {
    try {
      current = JSON.parse(await readBody(req));
      res.writeHead(204);
      return res.end();
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: String(e) }));
    }
  }

  if (url === "/snapshot" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(current));
  }

  // Used to exercise the dashboard's "agent unreachable" fallback.
  if (url === "/down") {
    res.writeHead(502, { "content-type": "application/json" });
    return res.end('{"error":"agent down"}');
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[fixture-server] listening on http://127.0.0.1:${PORT}`);
});
