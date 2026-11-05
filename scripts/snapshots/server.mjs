// Serves the snapshot app and answers its RPCs: canned fixtures for what would run pi, and the
// plugin's real handlers (compiled to .test-build) for the rest, over the demo files. Paths under
// /Users/ada map into the demo root on the way in and back out on the way out.
import { readFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtures, HOME, workspaces } from "./demo.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const require = createRequire(import.meta.url);

export function startServer(demo, { bundle, port = 0 }) {
  const build = path.join(repo, ".test-build");
  const pi = require(`${build}/server/pi.js`);
  const { pluginSettings } = require(`${build}/shared/contracts.js`);
  pi.applySettings({ ...pluginSettings.schema.parse({}), agentDir: demo.agentDir });
  const { registerHandlers } = require(`${build}/server/handlers.js`);
  const registry = new Map();
  registerHandlers({ handle: (contract, fn) => registry.set(contract.name, { contract, fn }) }, () => {});
  const canned = fixtures();

  const toReal = (value) => {
    if (typeof value === "string") return value.startsWith(HOME) ? demo.root + value : value;
    if (Array.isArray(value)) return value.map(toReal);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toReal(item)]));
    return value;
  };
  const toFake = (value) => JSON.parse(JSON.stringify(value).split(demo.root).join(""));
  const fonts = {
    "/fonts/inter.woff2": path.join(here, "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"),
    "/fonts/mono.woff2": path.join(here, "node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2"),
  };
  // react-native-web draws text in the system font stack; Inter and JetBrains Mono stand in for
  // the macOS system fonts the Paseo app uses.
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: "Segoe UI"; src: url(/fonts/inter.woff2) format("woff2"); font-weight: 100 900; }
@font-face { font-family: "Menlo"; src: url(/fonts/mono.woff2) format("woff2"); font-weight: 100 900; }
html, body, #root { margin: 0; min-height: 100%; -webkit-font-smoothing: antialiased; }
</style></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;

  const server = http.createServer(async (req, res) => {
    const send = (code, body, type = "application/json") => {
      res.writeHead(code, { "content-type": type });
      res.end(type === "application/json" ? JSON.stringify(body) : body);
    };
    try {
      const url = new URL(req.url, "http://demo");
      if (req.method === "GET" && url.pathname === "/") return send(200, page, "text/html");
      if (url.pathname === "/app.js") return send(200, readFileSync(bundle), "text/javascript");
      if (fonts[url.pathname]) return send(200, readFileSync(fonts[url.pathname]), "font/woff2");
      if (url.pathname.startsWith("/assets/")) return send(200, readFileSync(path.join(repo, url.pathname)), "image/png");
      if (url.pathname === "/workspaces") return send(200, workspaces);
      if (url.pathname !== "/rpc") return send(404, { error: "not found" });
      let body = "";
      for await (const chunk of req) body += chunk;
      const { name, input } = JSON.parse(body);
      const entry = registry.get(name);
      if (!entry) return send(404, { error: `no rpc ${name}` });
      const parsed = entry.contract.input.parse(input);
      const out = canned[name] ? canned[name](parsed) : toFake(await entry.fn(toReal(parsed), { paseo: demo.paseo }));
      const checked = entry.contract.output.safeParse(out);
      if (!checked.success) throw new Error(`${name} output: ${checked.error.message}`);
      return send(200, out);
    } catch (error) {
      console.error(error.message);
      return send(500, { error: error.message });
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}
