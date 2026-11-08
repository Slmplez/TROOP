import { clientModels } from "./react";
import { createResourceFacade } from "./resource-facade.mjs";
export const resources = createResourceFacade(clientModels, window.troop);
