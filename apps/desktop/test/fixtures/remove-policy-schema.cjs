// Remove the new extension when constructing an actual pre-policy database.
module.exports = function removePolicySchema(database) {
  database.exec(
    "DROP TRIGGER IF EXISTS operation_receipt_insert; DROP TRIGGER IF EXISTS operation_receipt_update; DROP TABLE IF EXISTS causal_writes; DROP TABLE IF EXISTS causal_limit_history; DROP TABLE IF EXISTS causal_limit_policies; DROP TABLE IF EXISTS operation_archives; DROP TABLE IF EXISTS operation_receipt_times; DROP TABLE IF EXISTS operation_archive_settings_history; DROP TABLE IF EXISTS operation_archive_settings;",
  );
};
