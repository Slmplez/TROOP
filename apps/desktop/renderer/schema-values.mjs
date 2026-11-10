export function schemaBranch(schema, value) {
  const branches = schema.anyOf ?? schema.oneOf;
  if (!branches) return schema;
  return (
    branches.find((branch) => value === null && branch.type === "null") ??
    branches.find(
      (branch) => value?.engine_id && branch.properties?.engine_id,
    ) ??
    branches.find(
      (branch) =>
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        branch.type === "object" &&
        !branch.properties?.engine_id,
    ) ??
    branches.find((branch) => branch.type === typeof value) ??
    branches.find((branch) => branch.type !== "null") ??
    branches[0]
  );
}

export function schemaDefault(schema, previous) {
  if (schema.anyOf || schema.oneOf)
    return schemaDefault(schemaBranch(schema, previous), previous);
  if (schema.default !== undefined) return structuredClone(schema.default);
  if (schema.enum)
    return schema.enum.includes(previous) ? previous : schema.enum[0];
  if (schema.type === "object")
    return Object.fromEntries(
      Object.entries(schema.properties ?? {})
        .filter(
          ([key]) =>
            schema.required?.includes(key) || previous?.[key] !== undefined,
        )
        .map(([key, field]) => [key, schemaDefault(field, previous?.[key])]),
    );
  if (schema.type === "array")
    return Array.isArray(previous) ? structuredClone(previous) : [];
  if (schema.type === "null") return null;
  if (schema.type === "integer" || schema.type === "number")
    return typeof previous === "number" ? previous : (schema.minimum ?? 0);
  if (schema.type === "boolean")
    return typeof previous === "boolean" ? previous : false;
  return typeof previous === "string" ? previous : "";
}

export function ruleFormSchema(catalogue, value) {
  const schema = structuredClone(catalogue.rule);
  for (const branch of schema.properties.start.anyOf) {
    if (branch.properties.engine_id)
      branch.properties.engine_id = { enum: catalogue.engines };
    if (!branch.properties.action) continue;
    const name = value.start?.action?.name;
    const action = catalogue.actions.find((action) => action.name === name);
    branch.properties.action = {
      type: "object",
      properties: {
        name: { enum: catalogue.actions.map((action) => action.name) },
        arguments: action?.parameters ?? { type: "object", properties: {} },
      },
      required: ["name", "arguments"],
    };
  }
  return schema;
}
