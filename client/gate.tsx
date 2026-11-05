// A notice for a screen that needs an extension: install it, or turn it on, in one tap.
import type { ReactNode } from "react";
import { extensionsListRpc, extensionsRunRpc, type ExtensionInfo } from "../shared/contracts";
import { useRpcMutation, useRpcQuery } from "./queries";
import { Button, ErrorBox, Notice } from "./ui";

const INVALIDATES = ["ext.list", "ext.search", "pi.overview", "claude.state", "res.skills", "res.prompts", "res.context"] as const;

/** The global state of an extension, from `pi extensions list`. */
export function useExtension(name: string): { loading: boolean; ext: ExtensionInfo | undefined } {
  const list = useRpcQuery(extensionsListRpc, { scope: "global" }, { staleTime: 30_000 });
  return { loading: list.isLoading, ext: list.data?.extensions.find((ext) => ext.name === name) };
}

export function ExtensionGate({ name, children }: { name: string; children: ReactNode }) {
  const { loading, ext } = useExtension(name);
  const run = useRpcMutation(extensionsRunRpc, {
    invalidates: INVALIDATES,
    success: (result) => (result.ok ? `${name} is on. Running pi sessions need /reload.` : null),
  });
  if (loading || ext?.enabled) return null;
  const failed = run.data && !run.data.ok ? <ErrorBox title={`pi could not ${ext ? "turn on" : "install"} ${name}`} error={run.data.output} /> : null;
  return (
    <>
      <Notice
        title={ext ? `The ${name} extension is off` : `The ${name} extension is not installed`}
        action={
          <Button
            small
            variant="primary"
            icon={ext ? "Power" : "Download"}
            label={ext ? "Turn on" : "Install"}
            busy={run.isPending}
            onPress={() => run.mutate(ext ? { action: "enable", target: ext.reference, scope: "global" } : { action: "install", target: `marketplace:${name}`, scope: "global" })}
          />
        }
      >
        {children}
      </Notice>
      {failed}
    </>
  );
}
