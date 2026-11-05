// @getpaseo/plugin/client for the snapshot app: RPCs go to the demo server over HTTP and are
// validated against their contracts on both sides, as Paseo does.
import { useState } from "react";

async function post(path: string, body: unknown) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

export async function callRpc(contract: any, input: unknown) {
  const out = await post("/rpc", { name: contract.name, input: contract.input.parse(input) });
  return contract.output.parse(out);
}

export function useRpc(contract: any) {
  return (input: unknown) => callRpc(contract, input);
}

const paseo = {
  workspaces: {
    list: async () => ({ entries: await (await fetch("/workspaces")).json(), pageInfo: {}, requestId: "demo" }),
    create: async () => {
      throw new Error("The demo does not create worktrees.");
    },
  },
  agents: { list: async () => ({ entries: [] }), ref: () => ({}) },
};

export function usePaseo() {
  return paseo as any;
}

export function useSettings(definition: any) {
  return { status: "ready", values: definition.schema.parse({}), revision: "1", saving: false, saveError: null, save: async () => true, reset: async () => true, reload: async () => {} } as any;
}

export function useWorkspace(_id: string, selector: (w: any) => unknown) {
  return selector((window as any).__workspace ?? {});
}
export function useAgent(_id: string, selector: (a: any) => unknown) {
  return selector({});
}
export function useHosts() {
  return [];
}
export function getPaseoClient() {
  return paseo;
}
export async function openExternalUrl() {}
export function useTabState() {
  return useState<unknown>(undefined);
}
export function defineTranslations(x: unknown) {
  return x;
}
export function useTranslation() {
  return { t: (s: string) => s };
}
