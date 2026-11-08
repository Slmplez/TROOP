// Legacy fallback is only for older Core versions without the projection.
export function actionFor(record, name, fallback = false) {
  return record?.allowed_actions?.[name] ?? { allowed: fallback, reason: null };
}
