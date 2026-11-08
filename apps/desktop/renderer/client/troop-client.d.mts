import type { Requests } from "../../contracts/execution.js";
export class ClientError extends Error {
  kind: string;
  retryability?: string;
  currentRevision?: number;
  operationRef?: string;
}
export class TroopClient {
  constructor(bridge: object);
  request<K extends keyof Requests>(
    method: K,
    input: Requests[K]["input"],
  ): Promise<Requests[K]["output"]>;
  onChatEvent(
    callback: (event: {
      generation: string;
      conversation_id: number;
      seq: number;
    }) => void,
  ): () => void;
}
