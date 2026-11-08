import type {
  OperationRequest,
  OperationReceipt,
  Requests,
} from "../../contracts/execution.js";
import type { TroopClient } from "./troop-client.mjs";

export interface OperationEntry {
  signature: string;
  attempted: boolean;
  redacted?: boolean;
  request: OperationRequest;
  receipt: OperationReceipt | null;
}
export class OperationJournal {
  constructor(
    storage: Pick<
      Storage,
      "length" | "key" | "getItem" | "setItem" | "removeItem"
    >,
    uuid?: () => string,
  );
  subscribe(listener: () => void): () => void;
  getSnapshot(): readonly OperationEntry[];
  entries(instance?: string): OperationEntry[];
  select(instance: string | null): void;
  prepare<K extends keyof Requests>(
    instance: string,
    method: K,
    input: Requests[K]["input"],
  ): OperationEntry;
  query(client: TroopClient, entry: OperationEntry): Promise<OperationReceipt>;
  prepareSensitive<K extends keyof Requests>(
    instance: string,
    method: K,
    input: Requests[K]["input"],
  ): Promise<OperationEntry>;
  resolve(
    client: TroopClient,
    entry: OperationEntry,
    sensitiveInput?: unknown,
  ): Promise<OperationReceipt>;
  recover(client: TroopClient, instance: string): Promise<void>;
  acknowledge(entry: OperationEntry): void;
}
