// Build an actual pre-ledger fixture before replaying migrations 8/9 onward.
// Keeping schema-12 triggers while lowering user_version is not an old database.
module.exports = function removeLedgerSchema(db) {
  db.exec(
    "DROP TABLE followup_appointments; DROP TABLE followup_chains; DROP TABLE followup_states; DROP TABLE reminder_notifications; DROP TABLE reminder_slots; DROP TABLE reminder_states; DROP TABLE reminder_preferences; DROP TABLE group_executors; DROP TABLE group_chains; DROP TRIGGER group_project_revoked;",
  );
  db.exec(
    "DROP TABLE group_deliveries; DROP TABLE group_messages; DROP TABLE group_chats;",
  );
  db.exec("DROP TABLE work_item_runs; DROP TABLE work_items;");
  for (const { name } of db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'follow_*'",
    )
    .all()) {
    if (!/^follow_[A-Za-z_]+$/.test(name))
      throw Error("Unexpected fixture trigger");
    db.exec(`DROP TRIGGER ${name}`);
  }
  db.exec(
    "DROP TABLE cli_interactions; DROP TABLE memory_conflicts; DROP VIEW active_memory_entries; DROP TABLE memory_entries; DROP TRIGGER memory_legacy_no_insert; DROP TRIGGER memory_legacy_no_update; DROP TRIGGER memory_legacy_no_delete; DROP TRIGGER memory_revision_insert; DROP TRIGGER memory_revision_update; DROP TRIGGER memory_revision_no_update; DROP TRIGGER memory_revision_no_delete; DROP TABLE memory_revisions; DROP VIEW active_memories; DROP TABLE memory_forgetting; ALTER TABLE memories DROP COLUMN protected; ALTER TABLE memories DROP COLUMN source_ref; DROP TABLE source_event_receipts; DROP TABLE event_sources; DROP TABLE event_inbox; DROP TABLE event_deliveries; DROP TABLE event_leases; DROP TABLE source_events; DROP TABLE memory_maintenance_attempts; DROP TABLE memory_maintenance_settings; DROP TABLE automation_rules; DROP TABLE automation_deliveries; DROP TABLE authorizations; DROP TABLE authorization_history; DROP TABLE execution_changes; DROP TABLE execution_versions; DROP TABLE operations; DROP TABLE storage_identity;",
  );
};
