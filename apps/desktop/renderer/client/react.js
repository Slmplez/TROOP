import { useCallback, useSyncExternalStore } from "react";
import { TroopClient } from "./troop-client.mjs";
import { ClientModels } from "./models.mjs";
import { OperationJournal } from "./operation-journal.mjs";

export const troopClient = new TroopClient(window.troop);
export const operationJournal = new OperationJournal(window.localStorage);
export const clientModels = new ClientModels(troopClient, {
  journal: operationJournal,
});
const empty = Object.freeze({ data: null, loading: false, error: null });
const emptySnapshot = () => empty;
export function useClientModel(model, enabled = true) {
  const subscribe = useCallback(
    (listener) => (enabled && model ? model.subscribe(listener) : () => {}),
    [model, enabled],
  );
  return useSyncExternalStore(
    subscribe,
    enabled && model ? model.getSnapshot : emptySnapshot,
  );
}
