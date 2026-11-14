import type { Database } from "bun:sqlite";

/** Pure lookups keep authentication/store reads independent of purge execution. */
export function hasRetentionTable(db: Database, table: string): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}
export function purgedOwner(db: Database, kind: string, resourceId: string): string | undefined {
  if (!hasRetentionTable(db, "purged_resources")) return;
  return (db.query("SELECT owner_id FROM purged_resources WHERE kind=? AND id=?").get(kind, resourceId) as { owner_id: string } | null)?.owner_id;
}
export function purgedReceipt(db: Database, ownerId: string, keyHash: string): boolean {
  return hasRetentionTable(db, "purged_receipts") && !!db.query("SELECT 1 FROM purged_receipts WHERE owner_id=? AND key_hash=?").get(ownerId, keyHash);
}
export function purgedLegacySource(db: Database, ownerId: string, sourceHash: string): boolean {
  return hasRetentionTable(db, "purged_legacy_sources") && !!db.query("SELECT 1 FROM purged_legacy_sources WHERE owner_id=? AND source_hash=?").get(ownerId, sourceHash);
}
export function retainedFamilyTokens(db: Database, rootId: string): number {
  if (!hasRetentionTable(db, "family_usage_debits")) return 0;
  return Number((db.query("SELECT COALESCE(SUM(tokens),0) total FROM family_usage_debits WHERE root_thread_id=?").get(rootId) as { total: number }).total);
}
