import type {
  Requests,
  RunSnapshot,
  RunPage,
  EventPage,
  Event,
  Invocation,
  Task,
  SessionPage,
  MessagePage,
} from "../../contracts/execution.js";
import type { TroopClient } from "./troop-client.mjs";
import type { OperationJournal } from "./operation-journal.mjs";

export interface QuerySnapshot<T> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly error: Error | null;
}
export class QueryModel<T> {
  getSnapshot(): QuerySnapshot<T>;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  more(): Promise<void>;
}
export class ClientModels {
  constructor(
    client: TroopClient,
    options?: { pollInterval?: number; journal?: OperationJournal | null },
  );
  connect(status: {
    state: string;
    generation: string | null;
    protocol?: number | null;
    revision?: number;
    storage_instance?: string | null;
    capabilities?: string[];
    follow_resources?: string[];
  }): void;
  runs(): QueryModel<RunPage>;
  run(id: number): QueryModel<RunSnapshot>;
  events(id: number): QueryModel<EventPage>;
  event(id: number): QueryModel<Event>;
  invocation(id: number): QueryModel<Invocation>;
  task(id: number): QueryModel<Task>;
  sessions(): QueryModel<SessionPage>;
  session(id: number): QueryModel<MessagePage>;
  checkpoints(id: number): QueryModel<unknown[]>;
  agents(): QueryModel<unknown[]>;
  resource<K extends keyof Requests>(
    method: K,
    input: Requests[K]["input"],
  ): QueryModel<Requests[K]["output"]>;
  fetchResource<K extends keyof Requests>(
    method: K,
    input: Requests[K]["input"],
  ): Promise<Requests[K]["output"]>;
  read<K extends keyof Requests>(
    method: K,
    input: Requests[K]["input"],
  ): Promise<Requests[K]["output"]>;
  command<K extends keyof Requests>(
    method: K,
    input: Requests[K]["input"],
  ): Promise<Requests[K]["output"]>;
  invalidate(): void;
  dispose(): void;
}
