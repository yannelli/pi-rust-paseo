// A short-lived pi in RPC mode, for answers only a running pi has: its command list, and the
// output of extension commands. Dialogs are cancelled, since nobody can answer them.
// `PI_WORKFLOW_RUN` keeps the workflows extension from watching or reporting runs.
import { spawn } from "node:child_process";
import { piEnv, requirePi } from "./pi";
import { projectTrusted } from "./trust";

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export interface Notice {
  level: string;
  text: string;
}

export interface PiRpc {
  /** Sends one RPC command and resolves with its response record. */
  request(record: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Notifications that extensions sent since the session started. */
  notices: Notice[];
  /** Whether a dialog was cancelled because no UI can answer it. */
  dialogs: number;
}

export function withPiRpc<T>(cwd: string, work: (rpc: PiRpc) => Promise<T>, timeoutMs = 60_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(requirePi(), ["--mode", "rpc", "--no-session", projectTrusted(cwd) ? "--approve" : "--no-approve"], {
      cwd,
      env: piEnv({ PI_WORKFLOW_RUN: "paseo", PI_OFFLINE: "1" }),
      stdio: ["pipe", "pipe", "ignore"],
    });
    const pending = new Map<string, (record: Record<string, unknown>) => void>();
    const rpc: PiRpc = { notices: [], dialogs: 0, request: () => Promise.reject(new Error("closed")) };
    let next = 0;
    let buffer = "";
    let settled = false;
    const finish = (error: Error | null, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      setTimeout(() => child.kill("SIGTERM"), 500).unref();
      setTimeout(() => child.kill("SIGKILL"), 3500).unref();
      if (error) reject(error);
      else resolve(value as T);
    };
    const timer = setTimeout(() => finish(new Error("pi did not answer in time")), timeoutMs);
    const send = (record: unknown) => {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(record)}\n`);
    };
    rpc.request = (record) =>
      new Promise((done) => {
        const id = `r${next++}`;
        pending.set(id, done);
        send({ ...record, id });
      });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(new Error(`pi exited (${code}) before it answered`)));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.startsWith("{")) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (message.type === "extension_ui_request") {
          if (DIALOG_METHODS.has(String(message.method))) {
            rpc.dialogs += 1;
            send({ type: "extension_ui_response", id: message.id, cancelled: true });
          } else if (message.method === "notify" && typeof message.message === "string") {
            rpc.notices.push({ level: String(message.notifyType ?? "info"), text: message.message });
          }
          continue;
        }
        if (message.type === "response" && typeof message.id === "string") {
          pending.get(message.id)?.(message);
          pending.delete(message.id);
        }
      }
    });
    work(rpc).then(
      (value) => finish(null, value),
      (error: Error) => finish(error),
    );
  });
}
