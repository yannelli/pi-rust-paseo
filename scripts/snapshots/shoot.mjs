// Renders the README screenshots (assets/screenshots/*.png) and the hero image (assets/hero.png)
// from demo data: `npm run snapshots` in the repository root. Set CHROME_PATH to use a specific
// Chromium; otherwise it uses Playwright's Chromium or a system Chrome.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { chromium } from "playwright-core";
import { MAIN, setup, WORKTREE } from "./demo.mjs";
import { startServer } from "./server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const out = path.join(repo, "assets", "screenshots");
const local = (name) => path.join(here, "node_modules", name);

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = path.join(homedir(), ".cache", "ms-playwright");
  if (existsSync(cache)) {
    for (const dir of readdirSync(cache).filter((d) => d.startsWith("chromium")).sort().reverse()) {
      for (const sub of readdirSync(path.join(cache, dir))) {
        for (const name of ["chrome-headless-shell", "chrome"]) {
          const file = path.join(cache, dir, sub, name);
          if (existsSync(file)) return file;
        }
      }
    }
  }
  for (const file of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]) {
    if (existsSync(file)) return file;
  }
  throw new Error("No Chromium found. Set CHROME_PATH or run `npx playwright install chromium`.");
}

async function bundle() {
  const file = path.join(here, ".build", "app.js");
  await esbuild.build({
    entryPoints: [path.join(here, "app.tsx")],
    bundle: true,
    outfile: file,
    format: "esm",
    jsx: "automatic",
    logLevel: "warning",
    define: { "process.env.NODE_ENV": '"production"', __DEV__: "false", global: "window" },
    resolveExtensions: [".web.tsx", ".web.ts", ".tsx", ".ts", ".web.js", ".js", ".mjs", ".json"],
    alias: {
      "react-native": local("react-native-web"),
      react: local("react"),
      "react-dom": local("react-dom"),
      "@tanstack/react-query": local("@tanstack/react-query"),
      "lucide-react": local("lucide-react"),
      zod: path.join(repo, "node_modules", "zod"),
      "@getpaseo/plugin/client/ui": path.join(here, "mocks", "ui.tsx"),
      "@getpaseo/plugin/client": path.join(here, "mocks", "client.tsx"),
      "@getpaseo/plugin": path.join(repo, "node_modules", "@getpaseo", "plugin", "dist", "index.js"),
    },
  });
  return file;
}

const q = (params) => new URLSearchParams(params).toString();

/** Each screenshot: its query, viewport, and the clicks that set it up. */
const shots = [
  { name: "overview", query: { tab: "overview", cwd: WORKTREE }, height: 980, async act(page) { await page.getByRole("button", { name: "Check" }).last().click(); } },
  { name: "workflows", query: { tab: "workflows", cwd: WORKTREE }, height: 980 },
  { name: "runs", query: { tab: "runs", cwd: WORKTREE }, height: 900, async act(page) { await page.getByText("All workspaces", { exact: true }).click(); } },
  { name: "run", query: { tab: "runs", run: "wf-mw4demo1", cwd: WORKTREE }, height: 1000 },
  { name: "editor", query: { tab: "workflows", edit: "ship-change", scope: "global", cwd: WORKTREE }, height: 1000, async act(page) { await page.getByText("docs-check", { exact: true }).first().click(); } },
  {
    name: "run-dialog",
    query: { tab: "workflows", cwd: WORKTREE },
    height: 1220,
    async act(page) {
      await page.getByRole("button", { name: "Run", exact: true }).first().click();
      await page.getByText("New worktree", { exact: true }).first().click();
    },
  },
  { name: "extensions", query: { tab: "extensions", cwd: MAIN }, height: 900 },
  {
    name: "plugins",
    query: { tab: "plugins", cwd: WORKTREE },
    height: 1240,
    async act(page) {
      await page.getByText("pr-review", { exact: true }).first().click();
    },
  },
  {
    name: "skills",
    query: { tab: "skills", cwd: WORKTREE },
    height: 1300,
  },
  { name: "context", query: { tab: "context", cwd: WORKTREE }, height: 1300 },
  {
    name: "deferred",
    query: { tab: "extensions", cwd: WORKTREE },
    height: 1400,
    async act(page) {
      await page.getByLabel("Manage deferred").click();
      await page.waitForTimeout(1200);
      await page.getByRole("button", { name: "/deferred status" }).click();
      await page.waitForTimeout(800);
      await page.getByPlaceholder("mcp__github__create_issue").fill("mcp__github__delete_repo");
    },
  },
  { name: "composer", query: { view: "composer", w: "720" }, width: 720, height: 1040, element: { selector: "#popover", name: "popover" } },
  { name: "mobile-runs", query: { tab: "runs", cwd: WORKTREE, compact: "1" }, compact: true },
  { name: "mobile-composer", query: { view: "composer", compact: "1" }, compact: true },
  { name: "mobile-overview-light", query: { tab: "overview", cwd: WORKTREE, compact: "1", theme: "light" }, compact: true },
];

async function capture(browser, url, shot) {
  const page = await browser.newPage({
    viewport: shot.compact ? { width: 390, height: 844 } : { width: shot.width ?? 1280, height: shot.height ?? 900 },
    deviceScaleFactor: 2,
  });
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(`${url}/?${q({ view: "manager", ...shot.query })}`);
  await page.waitForTimeout(3500);
  if (shot.act) {
    try {
      await shot.act(page);
    } catch (error) {
      throw new Error(`${shot.name}: ${[error.message, ...errors].join("\n")}`);
    }
    await page.waitForTimeout(1500);
  }
  await page.screenshot({ path: path.join(out, `${shot.name}.png`) });
  if (shot.element) await page.locator(shot.element.selector).screenshot({ path: path.join(out, `${shot.element.name}.png`), omitBackground: true });
  await page.close();
  if (errors.length) throw new Error(`${shot.name}: ${errors.join("\n")}`);
  console.log(`  ${shot.name}.png`);
}

const mark = `<svg width="56" height="56" viewBox="165.29 165.29 469.43 469.43"><path fill="#DE5E28" d="M165.29 165.29H517.36V400H400V282.65H165.29Z"/><path fill="#A33B1A" d="M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z"/><path fill="#E6984F" d="M517.36 400H634.72V634.72H517.36Z"/></svg>`;

const fontCss = `@font-face { font-family: Inter; src: url(/fonts/inter.woff2) format("woff2"); font-weight: 100 900; }
* { box-sizing: border-box; margin: 0; } body { font-family: Inter, sans-serif; -webkit-font-smoothing: antialiased; }`;

function heroHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fontCss}
  .canvas { position: relative; width: 1280px; height: 640px; overflow: hidden; background: #111413;
    background-image: radial-gradient(900px 500px at 0% 0%, rgba(222,94,40,0.16), transparent 60%), radial-gradient(800px 600px at 100% 100%, rgba(32,116,74,0.28), transparent 60%); }
  .grid { position: absolute; inset: 0; background-image: linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px); background-size: 40px 40px; mask-image: radial-gradient(circle at 30% 40%, black, transparent 75%); }
  .copy { position: absolute; left: 72px; top: 92px; width: 470px; color: #fafafa; }
  h1 { font-size: 54px; line-height: 1.05; font-weight: 700; letter-spacing: -1.6px; margin-top: 28px; }
  h1 span { color: #A1A5A4; font-weight: 600; }
  p { margin-top: 20px; font-size: 19px; line-height: 1.5; color: #A1A5A4; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 30px; }
  .chip { font-size: 13px; font-weight: 600; color: #e7ece9; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.09); border-radius: 999px; padding: 6px 12px; }
  .window { position: absolute; left: 600px; top: 64px; width: 860px; border-radius: 16px; overflow: hidden; border: 1px solid #2c3230; box-shadow: 0 40px 120px rgba(0,0,0,0.6); background: #181B1A; }
  .bar { height: 30px; background: #1E2120; border-bottom: 1px solid #252B2A; display: flex; align-items: center; gap: 7px; padding-left: 13px; }
  .bar i { width: 10px; height: 10px; border-radius: 5px; background: #3a403e; display: block; }
  .window img { display: block; width: 860px; }
  .pop { position: absolute; left: 556px; top: 268px; width: 340px; border-radius: 16px; overflow: hidden; box-shadow: 0 30px 90px rgba(0,0,0,0.75), 0 0 0 1px #2c3230; }
  .pop img { display: block; width: 340px; }
  </style></head><body><div class="canvas"><div class="grid"></div>
  <div class="copy">${mark}<h1>Pi Rust<br/><span>for Paseo</span></h1>
  <p>Manage pi, its extensions, Claude plugins, skills, context, and live multi-agent workflows from the Paseo app, on desktop and phone.</p>
  <div class="chips"><span class="chip">Live workflow runs</span><span class="chip">Approvals</span><span class="chip">Worktrees</span><span class="chip">Claude plugins</span><span class="chip">Skills</span><span class="chip">Context</span><span class="chip">Background tasks</span></div></div>
  <div class="window"><div class="bar"><i></i><i></i><i></i></div><img src="/assets/screenshots/run.png"/></div>
  <div class="pop"><img src="/assets/screenshots/popover.png"/></div>
  </div></body></html>`;
}

function mobileHtml() {
  const phone = (file, caption) => `<figure><div class="phone"><img src="/assets/screenshots/${file}.png"/></div><figcaption>${caption}</figcaption></figure>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fontCss}
  .canvas { width: 1280px; height: 820px; background: #111413; display: flex; align-items: center; justify-content: center; gap: 56px;
    background-image: radial-gradient(700px 400px at 50% 0%, rgba(32,116,74,0.22), transparent 70%); }
  figure { display: flex; flex-direction: column; align-items: center; gap: 18px; }
  .phone { width: 312px; height: 676px; border-radius: 44px; padding: 10px; background: #050606; border: 1px solid #2c3230; box-shadow: 0 30px 80px rgba(0,0,0,0.55); overflow: hidden; }
  .phone img { width: 292px; height: 632px; object-fit: cover; object-position: top; border-radius: 34px; display: block; }
  figcaption { color: #A1A5A4; font-size: 15px; font-weight: 500; }
  </style></head><body><div class="canvas">${phone("mobile-runs", "Runs in a worktree")}${phone("mobile-composer", "Status pill in the chat")}${phone("mobile-overview-light", "Overview, light theme")}</div></body></html>`;
}

async function compose(browser, url, name, html, size) {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 2 });
  await page.route("**/compose", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${url}/compose`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);
  await page.screenshot({ path: name });
  await page.close();
  console.log(`  ${path.relative(repo, name)}`);
}

async function main() {
  console.log("Compiling the plugin's server code");
  execFileSync("npx", ["tsc", "-p", "tsconfig.test.json"], { cwd: repo, stdio: "inherit" });
  mkdirSync(out, { recursive: true });
  const file = await bundle();
  const demo = setup();
  const { server, url } = await startServer(demo, { bundle: file });
  const browser = await chromium.launch({ executablePath: chromePath() });
  try {
    console.log("Screenshots");
    // SHOTS=name,name renders only those, and skips the compositions.
    const only = process.env.SHOTS?.split(",").filter(Boolean);
    for (const shot of shots.filter((entry) => !only || only.includes(entry.name))) await capture(browser, url, shot);
    if (only) return;
    console.log("Compositions");
    await compose(browser, url, path.join(out, "mobile.png"), mobileHtml(), { width: 1280, height: 820 });
    await compose(browser, url, path.join(repo, "assets", "hero.png"), heroHtml(), { width: 1280, height: 640 });
  } finally {
    await browser.close();
    server.close();
    demo.cleanup();
  }
}

await main();
