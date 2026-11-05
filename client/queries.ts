// TanStack Query wrappers around the plugin's RPCs. Query keys start with the RPC name, so a
// mutation invalidates every query of the RPCs it changes.
import type { PluginRpcContract } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import type { input as ZodInput, output as ZodOutput, ZodType } from "zod";
import { errorMessage } from "./ui";

export function useRpcQuery<I extends ZodType, O extends ZodType>(
  contract: PluginRpcContract<I, O>,
  input: ZodInput<I>,
  options: Omit<UseQueryOptions<ZodOutput<O>, Error>, "queryKey" | "queryFn"> = {},
) {
  const call = useRpc(contract);
  return useQuery<ZodOutput<O>, Error>({
    queryKey: [contract.name, input],
    queryFn: () => call(input),
    ...options,
  });
}

export function useRpcMutation<I extends ZodType, O extends ZodType>(
  contract: PluginRpcContract<I, O>,
  options: {
    /** RPC names whose queries refetch after success. */
    invalidates?: readonly string[];
    /** A toast after success; a function gets the result. */
    success?: string | ((result: ZodOutput<O>) => string | null);
    /** Show failures as an error toast. Default true. */
    toastErrors?: boolean;
    onSuccess?: (result: ZodOutput<O>, input: ZodInput<I>) => void;
  } = {},
) {
  const call = useRpc(contract);
  const client = useQueryClient();
  const toast = useToast();
  return useMutation<ZodOutput<O>, Error, ZodInput<I>>({
    mutationFn: (input) => call(input),
    onSuccess: (result, input) => {
      for (const name of options.invalidates ?? []) void client.invalidateQueries({ queryKey: [name] });
      const message = typeof options.success === "function" ? options.success(result) : options.success;
      if (message) toast.show(message, { variant: "success" });
      options.onSuccess?.(result, input);
    },
    onError: (error) => {
      if (options.toastErrors !== false) toast.error(errorMessage(error));
    },
  });
}

/** Refetch every `ms` while `active`, else not at all. */
export function poll(active: boolean, ms = 1000): number | false {
  return active ? ms : false;
}
