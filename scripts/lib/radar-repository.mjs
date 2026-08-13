import path from "node:path";
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { attachmentAvailabilityStates, defaultSearchProfile, knownEtimadActivityValues, seedActivities, seedSubActivities } from "./activity-catalog-seed.mjs";
import { defaultPlan, regions } from "./sync-plan.mjs";
import {
  approvalTtlMs,
  approvalIntentTtlMs,
  assessApprovalUsability,
  downloadApprovalAction,
  hashDownloadManifest,
  maxFileBytes,
  validateDownloadRequest,
  verifyDownloadConsent,
} from "./download-gate.mjs";

const migrationVersion = 5;
const trackedTenderFields = ["title", "agency", "fee", "region", "deadline", "publishedAt", "platformStatus", "activity", "etimadUrl"];

function safeJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); }
  catch { return fallback; }
}

function toBoolean(value) { return Number(value) === 1; }

function rowToTender(row) {
  const details = safeJson(row.detail_fields_json, {});
  return {
    id: row.reference,
    reference: row.reference,
    title: row.title,
    agency: row.agency,
    fee: Number(row.fee),
    region: row.region,
    deadline: row.deadline,
    publishedAt: row.published_at,
    status: row.user_status || "جديدة",
    documents: row.document_status || "لم تُفتح",
    score: Number(row.score ?? 60),
    platformStatus: row.platform_status,
    activity: row.activity,
    subActivity: details.subActivity || row.sub_activity || undefined,
    tenderType: details.tenderType || row.tender_type || undefined,
    etimadUrl: row.etimad_url,
    tenderNumber: details.tenderNumber || row.tender_number || undefined,
    contractDuration: details.contractDuration || row.contract_duration || undefined,
    guarantee: details.guarantee || row.guarantee || undefined,
    location: details.location || row.location || undefined,
    quantitySummary: details.quantitySummary || row.quantity_summary || undefined,
    remoteAttachments: safeJson(row.detail_attachment_names_json || row.attachment_names_json, []).map((item) => typeof item === "string" ? item : item.displayName),
    details: row.detail_status ? {
      status: row.detail_status,
      inspectedAt: row.detail_inspected_at,
      pageTitle: row.detail_page_title || "",
      sourceUrl: row.detail_source_url || row.etimad_url,
      fields: details,
      sections: safeJson(row.detail_sections_json, []),
      attachments: safeJson(row.detail_attachment_names_json, []),
      errorMessage: row.detail_error_message || undefined,
    } : undefined,
    review: safeJson(row.review_json, undefined),
    active: toBoolean(row.active),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

function comparable(item) {
  return Object.fromEntries(trackedTenderFields.map((field) => [field, item[field] ?? null]));
}

export async function createRadarRepository({ projectRoot }) {
  const privateDir = path.join(projectRoot, ".radar-data");
  await mkdir(privateDir, { recursive: true });
  const databasePath = path.join(privateDir, "radar.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tenders (
      reference TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      agency TEXT NOT NULL,
      fee INTEGER NOT NULL DEFAULT 0 CHECK (fee >= 0),
      region TEXT NOT NULL,
      deadline TEXT NOT NULL,
      published_at TEXT NOT NULL DEFAULT '',
      platform_status TEXT NOT NULL DEFAULT '',
      activity TEXT NOT NULL DEFAULT '',
      sub_activity TEXT NOT NULL DEFAULT '',
      tender_type TEXT NOT NULL DEFAULT '',
      etimad_url TEXT NOT NULL DEFAULT '',
      tender_number TEXT NOT NULL DEFAULT '',
      contract_duration TEXT NOT NULL DEFAULT '',
      guarantee TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      quantity_summary TEXT NOT NULL DEFAULT '',
      attachment_names_json TEXT NOT NULL DEFAULT '[]',
      source_hash TEXT NOT NULL DEFAULT '',
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
    );

    CREATE TABLE IF NOT EXISTS tender_user_state (
      tender_reference TEXT PRIMARY KEY REFERENCES tenders(reference) ON DELETE CASCADE,
      user_status TEXT NOT NULL DEFAULT 'جديدة',
      document_status TEXT NOT NULL DEFAULT 'لم تُفتح',
      score INTEGER NOT NULL DEFAULT 60 CHECK (score BETWEEN 0 AND 100),
      review_json TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_runs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'partial', 'failed')),
      regions_targeted INTEGER NOT NULL DEFAULT 13,
      regions_completed INTEGER NOT NULL DEFAULT 0,
      target_per_region INTEGER NOT NULL DEFAULT 100,
      checked_count INTEGER NOT NULL DEFAULT 0,
      new_count INTEGER NOT NULL DEFAULT 0,
      changed_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      resume_cursor TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_regions (
      sync_run_id TEXT NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
      region_id TEXT NOT NULL,
      region_name TEXT NOT NULL,
      status TEXT NOT NULL,
      checked_count INTEGER NOT NULL DEFAULT 0,
      finished_at TEXT,
      error_message TEXT,
      PRIMARY KEY (sync_run_id, region_id)
    );

    CREATE TABLE IF NOT EXISTS sync_checkpoints (
      sync_run_id TEXT NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
      region_id TEXT NOT NULL,
      region_name TEXT NOT NULL,
      fee_bucket TEXT NOT NULL,
      page_number INTEGER NOT NULL,
      checked_count INTEGER NOT NULL DEFAULT 0,
      captured_count INTEGER NOT NULL DEFAULT 0,
      next_cursor_json TEXT NOT NULL,
      saved_at TEXT NOT NULL,
      PRIMARY KEY (sync_run_id, region_id, fee_bucket, page_number)
    );

    CREATE TABLE IF NOT EXISTS sync_observations (
      sync_run_id TEXT NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
      tender_reference TEXT NOT NULL,
      region_id TEXT NOT NULL,
      fee_bucket TEXT NOT NULL,
      page_number INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY (sync_run_id, tender_reference, region_id)
    );

    CREATE TABLE IF NOT EXISTS tender_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tender_reference TEXT NOT NULL,
      sync_run_id TEXT NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
      field_name TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      observed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tender_reference TEXT NOT NULL REFERENCES tenders(reference) ON DELETE CASCADE,
      display_name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'supporting',
      remote_visible INTEGER NOT NULL DEFAULT 1 CHECK (remote_visible IN (0, 1)),
      download_status TEXT NOT NULL DEFAULT 'not-downloaded',
      availability TEXT NOT NULL DEFAULT 'unknown' CHECK (availability IN ('metadata-only', 'free-available', 'purchased-available', 'restricted', 'unknown')),
      requires_approval INTEGER NOT NULL DEFAULT 1 CHECK (requires_approval IN (0, 1)),
      availability_updated_at TEXT,
      local_path TEXT,
      sha256 TEXT,
      mime_type TEXT,
      size INTEGER,
      UNIQUE (tender_reference, display_name)
    );

    CREATE TABLE IF NOT EXISTS activity_catalog (
      id TEXT PRIMARY KEY,
      etimad_value TEXT,
      name_ar TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL DEFAULT 'seed' CHECK (source IN ('seed', 'etimad-visible', 'user')),
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sub_activity_catalog (
      id TEXT PRIMARY KEY,
      activity_id TEXT NOT NULL REFERENCES activity_catalog(id) ON DELETE CASCADE,
      etimad_value TEXT,
      name_ar TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'seed' CHECK (source IN ('seed', 'etimad-visible', 'user')),
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      UNIQUE (activity_id, name_ar)
    );

    CREATE TABLE IF NOT EXISTS search_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      activity_id TEXT REFERENCES activity_catalog(id) ON DELETE SET NULL,
      sub_activity_ids_json TEXT NOT NULL DEFAULT '[]',
      region_ids_json TEXT NOT NULL DEFAULT '[]',
      platform_statuses_json TEXT NOT NULL DEFAULT '[]',
      fee_min INTEGER NOT NULL DEFAULT 0 CHECK (fee_min >= 0),
      fee_max INTEGER CHECK (fee_max IS NULL OR fee_max >= fee_min),
      target_per_region INTEGER NOT NULL DEFAULT 100 CHECK (target_per_region BETWEEN 1 AND 100),
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tender_details (
      tender_reference TEXT PRIMARY KEY REFERENCES tenders(reference) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('complete', 'partial', 'failed')),
      inspected_at TEXT NOT NULL,
      source_url TEXT NOT NULL,
      page_title TEXT NOT NULL DEFAULT '',
      fields_json TEXT NOT NULL DEFAULT '{}',
      sections_json TEXT NOT NULL DEFAULT '[]',
      attachment_names_json TEXT NOT NULL DEFAULT '[]',
      content_hash TEXT NOT NULL,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS tender_detail_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tender_reference TEXT NOT NULL REFERENCES tenders(reference) ON DELETE CASCADE,
      inspected_at TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      UNIQUE (tender_reference, content_hash)
    );

    CREATE TABLE IF NOT EXISTS analysis_runs (
      id TEXT PRIMARY KEY,
      tender_reference TEXT NOT NULL REFERENCES tenders(reference) ON DELETE CASCADE,
      agent_name TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      result_json TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS decisions (
      tender_reference TEXT PRIMARY KEY REFERENCES tenders(reference) ON DELETE CASCADE,
      decision TEXT NOT NULL,
      score INTEGER NOT NULL,
      confidence TEXT NOT NULL,
      reasons_json TEXT NOT NULL DEFAULT '[]',
      missing_json TEXT NOT NULL DEFAULT '[]',
      risks_json TEXT NOT NULL DEFAULT '[]',
      human_override TEXT,
      human_notes TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      tender_reference TEXT REFERENCES tenders(reference) ON DELETE CASCADE,
      action TEXT NOT NULL CHECK (action = 'download-attachments'),
      target TEXT NOT NULL DEFAULT '',
      scope_json TEXT NOT NULL DEFAULT '{}',
      scope_hash TEXT NOT NULL DEFAULT '',
      requested_at TEXT,
      approved_at TEXT NOT NULL,
      expires_at TEXT,
      consumed_at TEXT,
      revoked_at TEXT,
      status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'consumed', 'expired', 'revoked'))
    );

    CREATE TABLE IF NOT EXISTS download_jobs (
      id TEXT PRIMARY KEY,
      approval_id TEXT REFERENCES approvals(id) ON DELETE SET NULL,
      tender_reference TEXT NOT NULL,
      manifest_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'blocked', 'complete', 'failed')),
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS approval_intents (
      id TEXT PRIMARY KEY,
      tender_reference TEXT NOT NULL REFERENCES tenders(reference) ON DELETE CASCADE,
      action TEXT NOT NULL CHECK (action = 'download-attachments'),
      scope_json TEXT NOT NULL,
      scope_hash TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      confirmed_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'expired', 'cancelled'))
    );

    CREATE TABLE IF NOT EXISTS sync_baseline (
      reference TEXT PRIMARY KEY,
      imported_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS automation_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at TEXT NOT NULL,
      sync_id TEXT,
      state TEXT NOT NULL,
      counts_json TEXT,
      message TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tenders_last_seen ON tenders(last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tenders_active ON tenders(active, deadline);
    CREATE INDEX IF NOT EXISTS idx_changes_reference ON tender_changes(tender_reference, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sync_observations_run ON sync_observations(sync_run_id, region_id);
    CREATE INDEX IF NOT EXISTS idx_tender_detail_history_reference ON tender_detail_history(tender_reference, inspected_at DESC);
  `);

  // ترقية آمنة من v3: إضافة أعمدة إتاحة المرفقات لقواعد أُنشئت قبل Schema v4 دون فقدان بياناتها.
  function ensureColumn(table, column, definition) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    if (!columns.includes(column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
  ensureColumn("attachments", "availability", "availability TEXT NOT NULL DEFAULT 'unknown' CHECK (availability IN ('metadata-only', 'free-available', 'purchased-available', 'restricted', 'unknown'))");
  ensureColumn("attachments", "requires_approval", "requires_approval INTEGER NOT NULL DEFAULT 1 CHECK (requires_approval IN (0, 1))");
  ensureColumn("attachments", "availability_updated_at", "availability_updated_at TEXT");
  // ترقية آمنة من v4: توسعة approvals لبوابة تنزيل المرفقات دون فقدان الموافقات السابقة.
  ensureColumn("approvals", "target", "target TEXT NOT NULL DEFAULT ''");
  ensureColumn("approvals", "scope_json", "scope_json TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("approvals", "scope_hash", "scope_hash TEXT NOT NULL DEFAULT ''");
  ensureColumn("approvals", "requested_at", "requested_at TEXT");
  ensureColumn("approvals", "expires_at", "expires_at TEXT");
  ensureColumn("approvals", "revoked_at", "revoked_at TEXT");
  ensureColumn("approvals", "status", "status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'consumed', 'expired', 'revoked'))");

  // موافقات v4 لم تكن مرتبطة بنطاق أو مدة؛ تُبطل صراحة ولا يمكن توريثها إلى مسار تنزيل حي.
  database.prepare(`
    UPDATE approvals SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
    WHERE COALESCE(scope_hash, '') = '' OR expires_at IS NULL OR requested_at IS NULL
  `).run(new Date().toISOString());

  database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(migrationVersion, new Date().toISOString());

  const statements = {
    insertBaseline: database.prepare("INSERT OR IGNORE INTO sync_baseline (reference, imported_at) VALUES (?, ?)"),
    listBaseline: database.prepare("SELECT reference FROM sync_baseline ORDER BY reference"),
    listTenders: database.prepare(`
      SELECT t.*, s.user_status, s.document_status, s.score, s.review_json,
        d.status AS detail_status, d.inspected_at AS detail_inspected_at,
        d.source_url AS detail_source_url, d.page_title AS detail_page_title,
        d.fields_json AS detail_fields_json, d.sections_json AS detail_sections_json,
        d.attachment_names_json AS detail_attachment_names_json, d.error_message AS detail_error_message
      FROM tenders t
      LEFT JOIN tender_user_state s ON s.tender_reference = t.reference
      LEFT JOIN tender_details d ON d.tender_reference = t.reference
      ORDER BY t.published_at DESC, t.last_seen_at DESC
    `),
    getTender: database.prepare(`
      SELECT t.*, s.user_status, s.document_status, s.score, s.review_json,
        d.status AS detail_status, d.inspected_at AS detail_inspected_at,
        d.source_url AS detail_source_url, d.page_title AS detail_page_title,
        d.fields_json AS detail_fields_json, d.sections_json AS detail_sections_json,
        d.attachment_names_json AS detail_attachment_names_json, d.error_message AS detail_error_message
      FROM tenders t
      LEFT JOIN tender_user_state s ON s.tender_reference = t.reference
      LEFT JOIN tender_details d ON d.tender_reference = t.reference
      WHERE t.reference = ?
    `),
    insertRun: database.prepare(`
      INSERT INTO sync_runs (id, started_at, status, regions_targeted, target_per_region)
      VALUES (?, ?, 'running', ?, ?)
    `),
    resumableRun: database.prepare(`
      SELECT * FROM sync_runs
      WHERE status IN ('partial', 'running') AND resume_cursor IS NOT NULL
        AND started_at > COALESCE((SELECT MAX(started_at) FROM sync_runs WHERE status = 'complete'), '')
      ORDER BY started_at DESC LIMIT 1
    `),
    latestRun: database.prepare("SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 1"),
    updateRunCheckpoint: database.prepare(`
      UPDATE sync_runs SET status = 'running', regions_completed = ?, checked_count = ?, resume_cursor = ?, error_message = NULL, finished_at = NULL
      WHERE id = ?
    `),
    partialRun: database.prepare(`
      UPDATE sync_runs SET status = 'partial', finished_at = ?, resume_cursor = ?, error_message = ?
      WHERE id = ?
    `),
    completeRun: database.prepare(`
      UPDATE sync_runs SET finished_at = ?, status = 'complete', regions_completed = ?, checked_count = ?, new_count = ?, changed_count = ?, error_message = NULL, resume_cursor = NULL
      WHERE id = ?
    `),
    failRun: database.prepare("UPDATE sync_runs SET finished_at = ?, status = 'failed', error_message = ? WHERE id = ?"),
    latestCompleteRun: database.prepare("SELECT * FROM sync_runs WHERE status = 'complete' ORDER BY finished_at DESC LIMIT 1"),
    markActivityInactive: database.prepare("UPDATE tenders SET active = 0 WHERE activity = ?"),
    getRun: database.prepare("SELECT * FROM sync_runs WHERE id = ?"),
    upsertRegion: database.prepare(`
      INSERT INTO sync_regions (sync_run_id, region_id, region_name, status, checked_count, finished_at, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sync_run_id, region_id) DO UPDATE SET
        status = excluded.status, checked_count = excluded.checked_count,
        finished_at = excluded.finished_at, error_message = excluded.error_message
    `),
    listRegions: database.prepare("SELECT * FROM sync_regions WHERE sync_run_id = ? ORDER BY CAST(region_id AS INTEGER)"),
    upsertCheckpoint: database.prepare(`
      INSERT INTO sync_checkpoints (
        sync_run_id, region_id, region_name, fee_bucket, page_number,
        checked_count, captured_count, next_cursor_json, saved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sync_run_id, region_id, fee_bucket, page_number) DO UPDATE SET
        checked_count = excluded.checked_count, captured_count = excluded.captured_count,
        next_cursor_json = excluded.next_cursor_json, saved_at = excluded.saved_at
    `),
    upsertObservation: database.prepare(`
      INSERT INTO sync_observations (
        sync_run_id, tender_reference, region_id, fee_bucket, page_number, payload_json, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sync_run_id, tender_reference, region_id) DO UPDATE SET
        fee_bucket = excluded.fee_bucket, page_number = excluded.page_number,
        payload_json = excluded.payload_json, observed_at = excluded.observed_at
    `),
    listObservations: database.prepare("SELECT payload_json FROM sync_observations WHERE sync_run_id = ? ORDER BY observed_at, tender_reference"),
    countObservations: database.prepare("SELECT COUNT(*) AS count FROM sync_observations WHERE sync_run_id = ?"),
    updateAttachmentNames: database.prepare("UPDATE tenders SET attachment_names_json = ? WHERE reference = ?"),
    hideAttachments: database.prepare("UPDATE attachments SET remote_visible = 0 WHERE tender_reference = ?"),
    listAttachmentsAll: database.prepare("SELECT * FROM attachments ORDER BY tender_reference, id"),
    setAttachmentAvailability: database.prepare(`
      UPDATE attachments SET availability = ?, requires_approval = ?, availability_updated_at = ?
      WHERE tender_reference = ? AND display_name = ?
    `),
    markAttachmentDownloaded: database.prepare(`
      UPDATE attachments SET download_status = 'downloaded', local_path = ?, sha256 = ?, mime_type = ?, size = ?
      WHERE tender_reference = ? AND display_name = ? AND remote_visible = 1 AND availability = 'free-available'
    `),
    insertActivity: database.prepare(`
      INSERT INTO activity_catalog (id, etimad_value, name_ar, source, active, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(name_ar) DO UPDATE SET
        etimad_value = COALESCE(activity_catalog.etimad_value, excluded.etimad_value),
        last_seen_at = excluded.last_seen_at
    `),
    insertSubActivity: database.prepare(`
      INSERT INTO sub_activity_catalog (id, activity_id, etimad_value, name_ar, source, active, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(activity_id, name_ar) DO UPDATE SET
        etimad_value = COALESCE(sub_activity_catalog.etimad_value, excluded.etimad_value),
        last_seen_at = excluded.last_seen_at
    `),
    listActivities: database.prepare("SELECT * FROM activity_catalog ORDER BY rowid"),
    listSubActivities: database.prepare("SELECT * FROM sub_activity_catalog ORDER BY rowid"),
    getActivityByName: database.prepare("SELECT * FROM activity_catalog WHERE name_ar = ?"),
    listSearchProfiles: database.prepare("SELECT * FROM search_profiles ORDER BY created_at, rowid"),
    getSearchProfile: database.prepare("SELECT * FROM search_profiles WHERE id = ?"),
    insertSearchProfile: database.prepare(`
      INSERT INTO search_profiles (
        id, name, activity_id, sub_activity_ids_json, region_ids_json, platform_statuses_json,
        fee_min, fee_max, target_per_region, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateSearchProfile: database.prepare(`
      UPDATE search_profiles SET
        name = ?, activity_id = ?, sub_activity_ids_json = ?, region_ids_json = ?, platform_statuses_json = ?,
        fee_min = ?, fee_max = ?, target_per_region = ?, enabled = ?, updated_at = ?
      WHERE id = ?
    `),
    disableOtherProfiles: database.prepare("UPDATE search_profiles SET enabled = 0, updated_at = ? WHERE id != ? AND enabled = 1"),
    updateTenderFromDetails: database.prepare(`
      UPDATE tenders SET
        tender_number = COALESCE(NULLIF(?, ''), tender_number),
        tender_type = COALESCE(NULLIF(?, ''), tender_type),
        sub_activity = COALESCE(NULLIF(?, ''), sub_activity),
        contract_duration = COALESCE(NULLIF(?, ''), contract_duration),
        guarantee = COALESCE(NULLIF(?, ''), guarantee),
        location = COALESCE(NULLIF(?, ''), location),
        quantity_summary = COALESCE(NULLIF(?, ''), quantity_summary)
      WHERE reference = ?
    `),
    upsertDetails: database.prepare(`
      INSERT INTO tender_details (
        tender_reference, status, inspected_at, source_url, page_title,
        fields_json, sections_json, attachment_names_json, content_hash, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tender_reference) DO UPDATE SET
        status = excluded.status, inspected_at = excluded.inspected_at, source_url = excluded.source_url,
        page_title = excluded.page_title, fields_json = excluded.fields_json,
        sections_json = excluded.sections_json, attachment_names_json = excluded.attachment_names_json,
        content_hash = excluded.content_hash, error_message = excluded.error_message
    `),
    insertDetailsHistory: database.prepare(`
      INSERT OR IGNORE INTO tender_detail_history (tender_reference, inspected_at, content_hash, payload_json)
      VALUES (?, ?, ?, ?)
    `),
    detailsStats: database.prepare(`
      SELECT COUNT(*) AS inspected,
        SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS complete,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM tender_details
    `),
    upsertTender: database.prepare(`
      INSERT INTO tenders (
        reference, title, agency, fee, region, deadline, published_at, platform_status, activity,
        sub_activity, tender_type, etimad_url, tender_number, contract_duration, guarantee, location,
        quantity_summary, attachment_names_json, source_hash, first_seen_at, last_seen_at, active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(reference) DO UPDATE SET
        title = excluded.title, agency = excluded.agency, fee = excluded.fee, region = excluded.region,
        deadline = excluded.deadline, published_at = excluded.published_at, platform_status = excluded.platform_status,
        activity = excluded.activity, sub_activity = excluded.sub_activity, tender_type = excluded.tender_type,
        etimad_url = excluded.etimad_url, tender_number = excluded.tender_number,
        contract_duration = excluded.contract_duration, guarantee = excluded.guarantee, location = excluded.location,
        quantity_summary = excluded.quantity_summary, attachment_names_json = excluded.attachment_names_json,
        source_hash = excluded.source_hash, last_seen_at = excluded.last_seen_at, active = 1
    `),
    ensureUserState: database.prepare(`
      INSERT OR IGNORE INTO tender_user_state (tender_reference, user_status, document_status, score, updated_at)
      VALUES (?, 'جديدة', 'لم تُفتح', ?, ?)
    `),
    insertChange: database.prepare(`
      INSERT INTO tender_changes (tender_reference, sync_run_id, field_name, old_value, new_value, observed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    upsertAttachment: database.prepare(`
      INSERT INTO attachments (tender_reference, display_name, kind, remote_visible, availability)
      VALUES (?, ?, ?, 1, 'metadata-only')
      ON CONFLICT(tender_reference, display_name) DO UPDATE SET
        kind = excluded.kind, remote_visible = 1,
        availability = CASE WHEN attachments.availability = 'unknown' THEN 'metadata-only' ELSE attachments.availability END
    `),
    detailHistoryCount: database.prepare("SELECT COUNT(*) AS count FROM tender_detail_history WHERE tender_reference = ?"),
    getState: database.prepare("SELECT value_json FROM app_state WHERE key = ?"),
    setState: database.prepare(`
      INSERT INTO app_state (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `),
    insertAutomationHistory: database.prepare(`
      INSERT INTO automation_history (recorded_at, sync_id, state, counts_json, message)
      VALUES (?, ?, ?, ?, ?)
    `),
    insertApproval: database.prepare(`
      INSERT INTO approvals (
        id, tender_reference, action, target, scope_json, scope_hash,
        requested_at, approved_at, expires_at, consumed_at, revoked_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'approved')
    `),
    getApproval: database.prepare("SELECT * FROM approvals WHERE id = ?"),
    consumeApproval: database.prepare(`
      UPDATE approvals SET consumed_at = ?, status = 'consumed'
      WHERE id = ? AND status = 'approved' AND consumed_at IS NULL AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
    `),
    revokeApproval: database.prepare(`
      UPDATE approvals SET revoked_at = ?, status = 'revoked'
      WHERE id = ? AND status = 'approved' AND consumed_at IS NULL
    `),
    markApprovalExpired: database.prepare(`
      UPDATE approvals SET status = 'expired'
      WHERE id = ? AND status = 'approved' AND expires_at IS NOT NULL AND expires_at <= ?
    `),
    insertDownloadJob: database.prepare(`
      INSERT INTO download_jobs (id, approval_id, tender_reference, manifest_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    updateDownloadJob: database.prepare(`
      UPDATE download_jobs SET status = ?, started_at = COALESCE(?, started_at), finished_at = COALESCE(?, finished_at), error_message = ?
      WHERE id = ?
    `),
    getDownloadJob: database.prepare("SELECT * FROM download_jobs WHERE id = ?"),
    listDownloadJobs: database.prepare("SELECT * FROM download_jobs ORDER BY created_at DESC, rowid DESC"),
    listDownloadJobsForTender: database.prepare("SELECT * FROM download_jobs WHERE tender_reference = ? ORDER BY created_at DESC, rowid DESC"),
    insertApprovalIntent: database.prepare(`
      INSERT INTO approval_intents (id, tender_reference, action, scope_json, scope_hash, requested_at, expires_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `),
    getApprovalIntent: database.prepare("SELECT * FROM approval_intents WHERE id = ?"),
    expireApprovalIntent: database.prepare(`
      UPDATE approval_intents SET status = 'expired'
      WHERE id = ? AND status = 'pending' AND expires_at <= ?
    `),
    confirmApprovalIntent: database.prepare(`
      UPDATE approval_intents SET status = 'confirmed', confirmed_at = ?
      WHERE id = ? AND status = 'pending' AND expires_at > ?
    `),
  };

  function transaction(work) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  function catalogSnapshot() {
    const activities = statements.listActivities.all();
    const subs = statements.listSubActivities.all();
    return {
      activities,
      subs,
      byId: new Map(activities.map((row) => [row.id, row])),
      byName: new Map(activities.map((row) => [row.name_ar, row])),
      subById: new Map(subs.map((row) => [row.id, row])),
    };
  }

  function seedCatalog() {
    const now = new Date().toISOString();
    transaction(() => {
      const activityIds = new Map();
      seedActivities.forEach((name) => {
        const proposedId = `act-${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
        statements.insertActivity.run(proposedId, knownEtimadActivityValues[name] || null, name, "seed", now, now);
        activityIds.set(name, statements.getActivityByName.get(name).id);
      });
      for (const [activityName, names] of Object.entries(seedSubActivities)) {
        const activityId = activityIds.get(activityName);
        if (!activityId) continue;
        [...new Set(names)].forEach((name) => {
          const id = `sub-${createHash("sha256").update(`${activityName}:${name}`).digest("hex").slice(0, 12)}`;
          statements.insertSubActivity.run(id, activityId, null, name, "seed", now, now);
        });
      }
      if (!statements.getSearchProfile.get("profile-default")) {
        const activity = statements.getActivityByName.get(defaultSearchProfile.activityName);
        statements.insertSearchProfile.run(
          "profile-default", defaultSearchProfile.name, activity?.id || null,
          JSON.stringify(defaultSearchProfile.subActivityNames || []), JSON.stringify(defaultSearchProfile.regionIds),
          JSON.stringify(defaultSearchProfile.platformStatuses), defaultSearchProfile.feeMin, defaultSearchProfile.feeMax,
          defaultSearchProfile.targetPerRegion, defaultSearchProfile.enabled ? 1 : 0, now, now,
        );
      }
    });
  }
  seedCatalog();

  function listActivityCatalog() {
    const catalog = catalogSnapshot();
    return catalog.activities.map((row) => ({
      id: row.id,
      name: row.name_ar,
      etimadValue: row.etimad_value,
      source: row.source,
      active: toBoolean(row.active),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      subActivities: catalog.subs.filter((sub) => sub.activity_id === row.id).map((sub) => ({
        id: sub.id,
        name: sub.name_ar,
        etimadValue: sub.etimad_value,
        source: sub.source,
        active: toBoolean(sub.active),
      })),
    }));
  }

  function rowToSearchProfile(row, catalog = catalogSnapshot()) {
    const activity = row.activity_id ? catalog.byId.get(row.activity_id) : null;
    const subActivityIds = safeJson(row.sub_activity_ids_json, []);
    const subActivities = subActivityIds.map((id) => catalog.subById.get(id)).filter(Boolean);
    const platformStatuses = safeJson(row.platform_statuses_json, []);
    const syncBlockers = [];
    if (!activity) syncBlockers.push("اختر نشاطًا أساسيًا محددًا.");
    else if (!activity.etimad_value) syncBlockers.push("قيمة هذا النشاط في اعتماد لم تُسجّل بعد.");
    if (subActivities.length) syncBlockers.push("فلتر الأنشطة الفرعية محفوظ، لكنه لم يُربط بالمزامنة الحية بعد.");
    if (platformStatuses.length !== 1 || platformStatuses[0] !== "المنافسات النشطة (تقديم العروض)") {
      syncBlockers.push("المزامنة الحالية تدعم المنافسات النشطة فقط.");
    }
    return {
      id: row.id,
      name: row.name,
      activityId: row.activity_id,
      activityName: activity?.name_ar || null,
      activityEtimadValue: activity?.etimad_value || null,
      subActivityIds,
      subActivityNames: subActivities.map((sub) => sub.name_ar),
      subActivityEtimadValues: subActivities.map((sub) => sub.etimad_value),
      regionIds: safeJson(row.region_ids_json, []),
      platformStatuses,
      feeMin: Number(row.fee_min),
      feeMax: row.fee_max === null || row.fee_max === undefined ? null : Number(row.fee_max),
      targetPerRegion: Number(row.target_per_region),
      enabled: toBoolean(row.enabled),
      syncReady: syncBlockers.length === 0,
      syncBlockers,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function invalidProfile(message) {
    const error = new Error(message);
    error.code = "INVALID_PROFILE";
    return error;
  }

  function normalizeSearchProfileInput(input, catalog = catalogSnapshot()) {
    const name = String(input?.name || "").trim();
    if (!name || name.length > 120) throw invalidProfile("اسم ملف البحث مطلوب وبحد أقصى 120 حرفًا.");
    const activityName = String(input?.activityName || "").trim();
    let activity = null;
    if (!activityName) throw invalidProfile("اختر نشاطًا أساسيًا واحدًا لملف المزامنة؛ خيار جميع الأنشطة للعرض المحلي فقط.");
    activity = catalog.byName.get(activityName) || null;
    if (!activity) throw invalidProfile(`النشاط الأساسي غير موجود في الكتالوج: ${activityName}`);
    const requestedSubs = Array.isArray(input?.subActivityNames) ? input.subActivityNames.map((value) => String(value).trim()).filter(Boolean) : [];
    const validSubs = catalog.subs.filter((row) => row.activity_id === activity?.id);
    const subActivityIds = [];
    for (const subName of [...new Set(requestedSubs)]) {
      const match = validSubs.find((row) => row.name_ar === subName);
      if (!match) throw invalidProfile(`النشاط الفرعي غير معروف لهذا النشاط الأساسي: ${subName}`);
      subActivityIds.push(match.id);
    }
    const regionIds = [...new Set((Array.isArray(input?.regionIds) ? input.regionIds : []).map((value) => String(value).trim()))]
      .filter((id) => regions.some((region) => region.id === id));
    const platformStatuses = [...new Set((Array.isArray(input?.platformStatuses) ? input.platformStatuses : []).map((value) => String(value).trim()).filter(Boolean))];
    const feeMin = Math.max(0, Math.floor(Number(input?.feeMin) || 0));
    const feeMax = input?.feeMax === null || input?.feeMax === undefined || input?.feeMax === "" ? null : Math.floor(Number(input.feeMax));
    if (feeMax !== null && (!Number.isFinite(feeMax) || feeMax < feeMin)) throw invalidProfile("الحد الأعلى لقيمة الكراسة يجب أن يساوي أو يفوق الحد الأدنى.");
    const target = Math.floor(Number(input?.targetPerRegion ?? 100));
    const targetPerRegion = Number.isFinite(target) ? Math.max(1, Math.min(100, target)) : 100;
    if (input?.enabled === true) {
      const candidate = {
        activity,
        requestedSubs: validSubs.filter((row) => subActivityIds.includes(row.id)),
        platformStatuses,
      };
      if (!candidate.activity.etimad_value) throw invalidProfile("لا يمكن تفعيل هذا الملف قبل تسجيل قيمة النشاط من اعتماد.");
      if (candidate.requestedSubs.length) throw invalidProfile("يمكن حفظ الأنشطة الفرعية الآن، لكن تفعيلها ينتظر ربط فلتر اعتماد في مرحلة لاحقة.");
      if (platformStatuses.length !== 1 || platformStatuses[0] !== "المنافسات النشطة (تقديم العروض)") {
        throw invalidProfile("لا يمكن تفعيل الملف حاليًا إلا لحالة المنافسات النشطة (تقديم العروض).");
      }
    }
    return {
      name,
      activityId: activity?.id || null,
      subActivityIds,
      regionIds,
      platformStatuses,
      feeMin,
      feeMax,
      targetPerRegion,
      enabled: input?.enabled === true,
    };
  }

  function listSearchProfiles() {
    const catalog = catalogSnapshot();
    return statements.listSearchProfiles.all().map((row) => rowToSearchProfile(row, catalog));
  }

  function getEnabledSearchProfile() {
    return listSearchProfiles().find((profile) => profile.enabled) || null;
  }

  function createSearchProfile(input) {
    const data = normalizeSearchProfileInput(input);
    const now = new Date().toISOString();
    const id = `profile-${now}-${crypto.randomUUID()}`;
    try {
      transaction(() => {
        if (data.enabled) statements.disableOtherProfiles.run(now, id);
        statements.insertSearchProfile.run(
          id, data.name, data.activityId, JSON.stringify(data.subActivityIds), JSON.stringify(data.regionIds),
          JSON.stringify(data.platformStatuses), data.feeMin, data.feeMax, data.targetPerRegion,
          data.enabled ? 1 : 0, now, now,
        );
      });
    } catch (error) {
      if (/UNIQUE/i.test(String(error?.message))) throw invalidProfile("اسم ملف البحث مستخدم بالفعل.");
      throw error;
    }
    return rowToSearchProfile(statements.getSearchProfile.get(id));
  }

  function updateSearchProfile(id, input) {
    const existing = statements.getSearchProfile.get(String(id));
    if (!existing) return null;
    const current = rowToSearchProfile(existing);
    const data = normalizeSearchProfileInput({ ...current, ...input });
    const now = new Date().toISOString();
    try {
      transaction(() => {
        if (data.enabled) statements.disableOtherProfiles.run(now, existing.id);
        statements.updateSearchProfile.run(
          data.name, data.activityId, JSON.stringify(data.subActivityIds), JSON.stringify(data.regionIds),
          JSON.stringify(data.platformStatuses), data.feeMin, data.feeMax, data.targetPerRegion,
          data.enabled ? 1 : 0, now, existing.id,
        );
      });
    } catch (error) {
      if (/UNIQUE/i.test(String(error?.message))) throw invalidProfile("اسم ملف البحث مستخدم بالفعل.");
      throw error;
    }
    return rowToSearchProfile(statements.getSearchProfile.get(existing.id));
  }

  function attachmentMetaMap() {
    const map = new Map();
    for (const row of statements.listAttachmentsAll.all()) {
      if (!map.has(row.tender_reference)) map.set(row.tender_reference, []);
      map.get(row.tender_reference).push({
        displayName: row.display_name,
        kind: row.kind,
        availability: row.availability,
        requiresApproval: toBoolean(row.requires_approval),
        remoteVisible: toBoolean(row.remote_visible),
        downloadStatus: row.download_status,
        localPath: row.local_path,
        sha256: row.sha256,
        mimeType: row.mime_type,
        size: row.size === null ? null : Number(row.size),
      });
    }
    return map;
  }

  function listAttachmentMeta(reference) {
    return attachmentMetaMap().get(String(reference)) || [];
  }

  function setAttachmentAvailability(reference, displayName, availability, { requiresApproval = true } = {}) {
    if (!attachmentAvailabilityStates.includes(availability)) {
      const error = new Error(`حالة إتاحة غير معروفة: ${availability}`);
      error.code = "INVALID_AVAILABILITY";
      throw error;
    }
    statements.setAttachmentAvailability.run(availability, requiresApproval ? 1 : 0, new Date().toISOString(), String(reference), String(displayName));
    return listAttachmentMeta(reference);
  }

  function markAttachmentDownloaded(reference, displayName, { localPath, sha256, mimeType = null, size } = {}) {
    if (!localPath || !/^[a-f0-9]{64}$/.test(String(sha256 || "")) || !Number.isSafeInteger(size) || size <= 0 || size > maxFileBytes) {
      const error = new Error("بيانات الملف المحلي غير صالحة للحفظ.");
      error.code = "INVALID_ATTACHMENT_RESULT";
      throw error;
    }
    const result = statements.markAttachmentDownloaded.run(
      String(localPath), String(sha256), mimeType ? String(mimeType) : null, size,
      String(reference), String(displayName),
    );
    if (Number(result.changes) !== 1) {
      const error = new Error("لم يعد المرفق ظاهرًا ومتاحًا مجانًا؛ أُلغي حفظ نتيجة التنزيل.");
      error.code = "ATTACHMENT_STATE_CHANGED";
      throw error;
    }
    return listAttachmentMeta(reference);
  }

  function rowToApproval(row) {
    if (!row) return null;
    return {
      id: row.id,
      tenderReference: row.tender_reference,
      action: row.action,
      target: row.target || "",
      scope: safeJson(row.scope_json, {}),
      scopeHash: row.scope_hash || "",
      requestedAt: row.requested_at,
      approvedAt: row.approved_at,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
      revokedAt: row.revoked_at,
      status: row.status || "approved",
    };
  }

  function getDownloadApproval(id, { now = new Date() } = {}) {
    const approval = rowToApproval(statements.getApproval.get(String(id)));
    const nowDate = now instanceof Date ? now : new Date(now);
    if (approval?.status === "approved" && approval.expiresAt && Date.parse(approval.expiresAt) <= nowDate.getTime()) {
      statements.markApprovalExpired.run(approval.id, nowDate.toISOString());
      approval.status = "expired";
    }
    if (approval?.status === "approved" && (!approval.scopeHash || !approval.expiresAt || !approval.requestedAt)) {
      statements.revokeApproval.run(nowDate.toISOString(), approval.id);
      approval.status = "revoked";
      approval.revokedAt = nowDate.toISOString();
    }
    return approval;
  }

  function rowToApprovalIntent(row) {
    if (!row) return null;
    return {
      id: row.id,
      tenderReference: row.tender_reference,
      action: row.action,
      scope: safeJson(row.scope_json, {}),
      scopeHash: row.scope_hash,
      requestedAt: row.requested_at,
      expiresAt: row.expires_at,
      confirmedAt: row.confirmed_at,
      status: row.status,
    };
  }

  function getDownloadApprovalIntent(id, { now = new Date() } = {}) {
    const nowDate = now instanceof Date ? now : new Date(now);
    const intent = rowToApprovalIntent(statements.getApprovalIntent.get(String(id)));
    if (intent?.status === "pending" && Date.parse(intent.expiresAt) <= nowDate.getTime()) {
      statements.expireApprovalIntent.run(intent.id, nowDate.toISOString());
      intent.status = "expired";
    }
    return intent;
  }

  // إنشاء الطلب لا يمنح أي صلاحية؛ يثبت فقط المنافسة والملفات في manifest غير قابل للتبديل.
  function requestDownloadApprovalIntent({ tenderReference, files, now = new Date() }) {
    const tender = getTender(tenderReference);
    if (!tender) {
      const error = new Error("المنافسة غير موجودة في قاعدة SQLite.");
      error.code = "TENDER_NOT_FOUND";
      throw error;
    }
    const manifest = validateDownloadRequest({ tenderReference: tender.reference, files, attachmentsMeta: tender.attachmentsMeta });
    const scopeHash = hashDownloadManifest(manifest);
    const nowDate = now instanceof Date ? now : new Date(now);
    const nowIso = nowDate.toISOString();
    const id = `approval-intent-${nowIso}-${crypto.randomUUID()}`;
    statements.insertApprovalIntent.run(
      id, tender.reference, downloadApprovalAction, JSON.stringify(manifest), scopeHash,
      nowIso, new Date(nowDate.getTime() + approvalIntentTtlMs).toISOString(),
    );
    return getDownloadApprovalIntent(id, { now: nowDate });
  }

  // التأكيد البشري هو وحده الذي ينشئ approval؛ الطلب المعلق وحده غير قابل للاستهلاك.
  function confirmDownloadApprovalIntent(id, { consentText, purchaseConfirmed, now = new Date() } = {}) {
    const nowDate = now instanceof Date ? now : new Date(now);
    const intent = getDownloadApprovalIntent(id, { now: nowDate });
    if (!intent) throw approvalError({ code: "APPROVAL_INTENT_NOT_FOUND", message: "طلب الموافقة غير موجود." });
    if (intent.status === "expired") throw approvalError({ code: "APPROVAL_INTENT_EXPIRED", message: "انتهت مهلة تأكيد الطلب؛ أنشئ طلبًا جديدًا." });
    if (intent.status !== "pending") throw approvalError({ code: "APPROVAL_INTENT_USED", message: "تم تأكيد هذا الطلب أو إغلاقه بالفعل." });
    const tender = getTender(intent.tenderReference);
    if (!tender) throw approvalError({ code: "TENDER_NOT_FOUND", message: "المنافسة غير موجودة في قاعدة SQLite." });
    validateDownloadRequest({ tenderReference: tender.reference, files: intent.scope.files, attachmentsMeta: tender.attachmentsMeta });
    verifyDownloadConsent({ consentText, purchaseConfirmed, bookletFee: tender.fee });
    if (hashDownloadManifest(intent.scope) !== intent.scopeHash) {
      throw approvalError({ code: "APPROVAL_SCOPE_MISMATCH", message: "تغيّر نطاق طلب الموافقة." });
    }
    const nowIso = nowDate.toISOString();
    const approvalId = `approval-${nowIso}-${crypto.randomUUID()}`;
    transaction(() => {
      const update = statements.confirmApprovalIntent.run(nowIso, intent.id, nowIso);
      if (Number(update.changes) !== 1) throw approvalError({ code: "APPROVAL_INTENT_USED", message: "تم تأكيد هذا الطلب أو انتهت صلاحيته." });
      statements.insertApproval.run(
        approvalId, tender.reference, downloadApprovalAction, "attachments", JSON.stringify(intent.scope), intent.scopeHash,
        nowIso, nowIso, new Date(nowDate.getTime() + approvalTtlMs).toISOString(),
      );
    });
    return getDownloadApproval(approvalId, { now: nowDate });
  }

  function approvalError(usability) {
    const error = new Error(usability.message || "الموافقة غير صالحة.");
    error.code = usability.code;
    return error;
  }

  // استهلاك الموافقة: استخدام واحد، انتهاء 10 دقائق، ومطابقة بصمة manifest إلزامية.
  function consumeDownloadApproval(id, { manifest, now = new Date() } = {}) {
    const approval = getDownloadApproval(id, { now });
    if (!manifest) throw approvalError({ code: "APPROVAL_SCOPE_MISMATCH", message: "يلزم إرسال manifest المطابق عند استهلاك الموافقة." });
    const scopeHash = hashDownloadManifest(manifest);
    const usability = assessApprovalUsability(approval, { scopeHash, now });
    if (!usability.usable) throw approvalError(usability);
    const nowIso = (now instanceof Date ? now : new Date(now)).toISOString();
    const result = statements.consumeApproval.run(nowIso, approval.id, nowIso);
    if (Number(result.changes) === 0) {
      throw approvalError({ code: "APPROVAL_CONSUMED", message: "استُخدمت هذه الموافقة بالفعل؛ الموافقة تُستخدم مرة واحدة." });
    }
    return getDownloadApproval(approval.id);
  }

  function revokeDownloadApproval(id) {
    const approval = getDownloadApproval(id);
    if (!approval) {
      const error = new Error("الموافقة غير موجودة.");
      error.code = "APPROVAL_NOT_FOUND";
      throw error;
    }
    statements.revokeApproval.run(new Date().toISOString(), approval.id);
    return getDownloadApproval(approval.id);
  }

  function rowToDownloadJob(row) {
    if (!row) return null;
    return {
      id: row.id,
      approvalId: row.approval_id,
      tenderReference: row.tender_reference,
      manifest: safeJson(row.manifest_json, {}),
      status: row.status,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      errorMessage: row.error_message,
    };
  }

  function recordDownloadJob({ approvalId, tenderReference, manifest, status = "pending", now = new Date() }) {
    const nowIso = (now instanceof Date ? now : new Date(now)).toISOString();
    const id = `dljob-${nowIso}-${crypto.randomUUID()}`;
    statements.insertDownloadJob.run(id, approvalId || null, String(tenderReference), JSON.stringify(manifest), status, nowIso);
    return rowToDownloadJob(statements.getDownloadJob.get(id));
  }

  function updateDownloadJob(id, { status, errorMessage = null, started = false, finished = false }) {
    const nowIso = new Date().toISOString();
    statements.updateDownloadJob.run(status, started ? nowIso : null, finished ? nowIso : null, errorMessage, String(id));
    return rowToDownloadJob(statements.getDownloadJob.get(id));
  }

  function listDownloadJobs(tenderReference) {
    const rows = tenderReference ? statements.listDownloadJobsForTender.all(String(tenderReference)) : statements.listDownloadJobs.all();
    return rows.map(rowToDownloadJob);
  }

  function seedBaseline(references) {
    const importedAt = new Date().toISOString();
    transaction(() => {
      for (const reference of references) statements.insertBaseline.run(String(reference), importedAt);
    });
  }

  function listTenders() {
    const meta = attachmentMetaMap();
    return statements.listTenders.all().map((row) => ({ ...rowToTender(row), attachmentsMeta: meta.get(row.reference) || [] }));
  }

  function getTender(reference) {
    const row = statements.getTender.get(reference);
    return row ? { ...rowToTender(row), attachmentsMeta: listAttachmentMeta(reference) } : null;
  }

  function saveVisibleAttachmentNames(reference, names) {
    const cleanNames = [...new Set((names || []).map((name) => String(name).trim()).filter(Boolean))];
    transaction(() => {
      statements.updateAttachmentNames.run(JSON.stringify(cleanNames), reference);
      for (const name of cleanNames) statements.upsertAttachment.run(reference, name, "supporting");
    });
    return cleanNames;
  }

  function saveTenderDetails(record) {
    const attachments = record.attachments || [];
    const attachmentNames = attachments.map((item) => item.displayName);
    const payload = {
      fields: record.fields || {},
      sections: record.sections || [],
      attachments,
      pageTitle: record.pageTitle || "",
      sourceUrl: record.sourceUrl || "",
    };
    const stablePayload = {
      ...payload,
      fields: Object.fromEntries(Object.entries(payload.fields).filter(([key]) => key !== "timeRemaining")),
      sections: payload.sections.map((section) => ({
        ...section,
        text: section.text.replace(/(الوقت المتبق[ىي]\s*\n)[^\n]+/g, "$1[قيمة متغيرة]")
      })),
    };
    const stableContent = JSON.stringify(stablePayload);
    const hash = createHash("sha256").update(stableContent).digest("hex");
    transaction(() => {
      statements.updateAttachmentNames.run(JSON.stringify(attachmentNames), record.reference);
      statements.hideAttachments.run(record.reference);
      for (const attachment of attachments) {
        statements.upsertAttachment.run(record.reference, attachment.displayName, attachment.kind || "supporting");
      }
      const fields = record.fields || {};
      statements.updateTenderFromDetails.run(
        fields.tenderNumber || "", fields.tenderType || "", fields.subActivity || "",
        fields.contractDuration || "", fields.guarantee || "", fields.location || "",
        fields.quantitySummary || "", record.reference,
      );
      statements.upsertDetails.run(
        record.reference, record.status || "complete", record.inspectedAt, record.sourceUrl || "",
        record.pageTitle || "", JSON.stringify(fields), JSON.stringify(record.sections || []),
        JSON.stringify(attachments), hash, record.errorMessage || null,
      );
      statements.insertDetailsHistory.run(record.reference, record.inspectedAt, hash, stableContent);
    });
    return getTender(record.reference);
  }

  function getDetailsStats() {
    const row = statements.detailsStats.get();
    return { inspected: Number(row?.inspected || 0), complete: Number(row?.complete || 0), failed: Number(row?.failed || 0) };
  }

  function getDetailHistoryCount(reference) {
    return Number(statements.detailHistoryCount.get(reference)?.count || 0);
  }

  function loadComparisonItems() {
    const tenders = listTenders();
    const byId = new Map(tenders.map((item) => [item.id, item]));
    for (const row of statements.listBaseline.all()) if (!byId.has(row.reference)) byId.set(row.reference, { id: row.reference, reference: row.reference });
    return [...byId.values()];
  }

  function startSyncRun({ regions = 13, targetPerRegion = 100 } = {}) {
    const startedAt = new Date().toISOString();
    const id = `sync-${startedAt}-${crypto.randomUUID()}`;
    statements.insertRun.run(id, startedAt, regions, targetPerRegion);
    return id;
  }

  function startOrResumeSyncRun({ regions = 13, targetPerRegion = 100, initialCursor } = {}) {
    const resumable = statements.resumableRun.get();
    if (resumable) {
      const savedCursor = safeJson(resumable.resume_cursor, null);
      const savedScope = savedCursor?.scopeKey;
      const requestedScope = initialCursor?.scopeKey;
      const legacyDefaultScope = !savedScope && requestedScope === defaultPlan.scopeKey;
      if (!requestedScope || savedScope === requestedScope || legacyDefaultScope) {
        return { id: resumable.id, resumed: true, cursor: { ...savedCursor, scopeKey: requestedScope || savedScope } };
      }
      statements.failRun.run(new Date().toISOString(), "أُغلقت الجولة الجزئية لأن ملف البحث النشط تغيّر؛ ستبدأ جولة جديدة بنطاق مستقل.", resumable.id);
    }
    const id = startSyncRun({ regions, targetPerRegion });
    statements.updateRunCheckpoint.run(0, 0, JSON.stringify(initialCursor), id);
    return { id, resumed: false, cursor: initialCursor };
  }

  function saveSyncCheckpoint(runId, checkpoint) {
    const savedAt = new Date().toISOString();
    const cursor = checkpoint.nextCursor;
    const run = statements.getRun.get(runId);
    const regionsCompleted = cursor.complete ? Number(run?.regions_targeted || 0) : Math.max(0, Number(cursor.regionIndex || 0));
    transaction(() => {
      for (const item of checkpoint.items || []) {
        statements.upsertObservation.run(
          runId, item.reference, checkpoint.regionId, checkpoint.feeBucket,
          checkpoint.pageNumber, JSON.stringify(item), savedAt,
        );
      }
      const regionComplete = cursor.complete || cursor.regionId !== checkpoint.regionId;
      statements.upsertRegion.run(
        runId, checkpoint.regionId, checkpoint.regionName, regionComplete ? "complete" : "running",
        checkpoint.regionChecked, regionComplete ? savedAt : null, null,
      );
      statements.upsertCheckpoint.run(
        runId, checkpoint.regionId, checkpoint.regionName, checkpoint.feeBucket,
        checkpoint.pageNumber, checkpoint.checked, checkpoint.items?.length || 0,
        JSON.stringify(cursor), savedAt,
      );
      statements.updateRunCheckpoint.run(regionsCompleted, checkpoint.checked, JSON.stringify(cursor), runId);
    });
  }

  function markSyncPartial(runId, { cursor, error }) {
    const message = String(error?.message || error || "توقفت الجولة ويمكن استئنافها");
    statements.partialRun.run(new Date().toISOString(), JSON.stringify(cursor), message, runId);
  }

  function loadDraftObservations(runId) {
    return statements.listObservations.all(runId).map((row) => safeJson(row.payload_json, null)).filter(Boolean);
  }

  function hasDraftObservations(runId) {
    return Number(statements.countObservations.get(runId)?.count || 0) > 0;
  }

  function getSyncProgress() {
    const run = statements.latestRun.get();
    if (!run) return null;
    return {
      id: run.id,
      status: run.status,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      regionsTargeted: Number(run.regions_targeted),
      regionsCompleted: Number(run.regions_completed),
      targetPerRegion: Number(run.target_per_region),
      checked: Number(run.checked_count),
      errorMessage: run.error_message,
      cursor: safeJson(run.resume_cursor, null),
      regions: statements.listRegions.all(run.id).map((row) => ({
        id: row.region_id,
        name: row.region_name,
        status: row.status,
        checked: Number(row.checked_count),
        finishedAt: row.finished_at,
        errorMessage: row.error_message,
      })),
    };
  }

  function failSyncRun(id, error) {
    statements.failRun.run(new Date().toISOString(), String(error?.message || error || "خطأ غير معروف"), id);
  }

  function saveCompletedSync(result, runId) {
    const observedAt = result.lastSyncAt;
    const before = new Map(listTenders().map((item) => [item.reference, item]));
    transaction(() => {
      if (result.scope?.replacesActivitySnapshot && result.scope?.activity) {
        statements.markActivityInactive.run(result.scope.activity);
      }
      for (const item of result.items) {
        const previous = before.get(item.reference);
        const snapshot = comparable(item);
        const sourceHash = JSON.stringify(snapshot);
        statements.upsertTender.run(
          item.reference, item.title || "", item.agency || "", Number(item.fee || 0), item.region || "غير محددة",
          item.deadline || "", item.publishedAt || "", item.platformStatus || "", item.activity || "",
          item.subActivity || "", item.tenderType || "", item.etimadUrl || "", item.tenderNumber || "",
          item.contractDuration || "", item.guarantee || "", item.location || "", item.quantitySummary || "",
          JSON.stringify(item.remoteAttachments || []), sourceHash, previous?.firstSeenAt || observedAt, observedAt,
        );
        statements.ensureUserState.run(item.reference, Number(item.score ?? 60), observedAt);
        for (const name of item.remoteAttachments || []) statements.upsertAttachment.run(item.reference, name, "supporting");
        if (previous) {
          for (const field of trackedTenderFields) {
            if (JSON.stringify(previous[field] ?? null) !== JSON.stringify(item[field] ?? null)) {
              statements.insertChange.run(item.reference, runId, field, JSON.stringify(previous[field] ?? null), JSON.stringify(item[field] ?? null), observedAt);
            }
          }
        }
      }
      statements.completeRun.run(result.lastSyncAt, result.regions, result.checked, result.added.length, result.changed.length, runId);
    });
  }

  function getDashboardSnapshot() {
    const latest = statements.latestCompleteRun.get();
    return {
      lastSyncAt: latest?.finished_at || null,
      checked: Number(latest?.checked_count || 0),
      regions: Number(latest?.regions_completed || 0),
      targetPerRegion: Number(latest?.target_per_region || 100),
      newItems: Number(latest?.new_count || 0),
      changedItems: Number(latest?.changed_count || 0),
      items: listTenders(),
      details: getDetailsStats(),
      database: { path: databasePath, schemaVersion: migrationVersion },
    };
  }

  function loadState(key, fallback) {
    return safeJson(statements.getState.get(key)?.value_json, fallback);
  }

  function saveState(key, value) {
    statements.setState.run(key, JSON.stringify(value), new Date().toISOString());
  }

  function recordAutomationStatus(status) {
    saveState("automation-status", status);
    if (status.lastSuccessAt && !status.dryRun) {
      statements.insertAutomationHistory.run(status.lastSuccessAt, status.syncId || null, status.state, JSON.stringify(status.counts || null), status.message || "");
    }
  }

  return {
    databasePath,
    schemaVersion: migrationVersion,
    seedBaseline,
    listTenders,
    getTender,
    saveVisibleAttachmentNames,
    saveTenderDetails,
    getDetailsStats,
    getDetailHistoryCount,
    loadComparisonItems,
    startSyncRun,
    startOrResumeSyncRun,
    saveSyncCheckpoint,
    markSyncPartial,
    loadDraftObservations,
    hasDraftObservations,
    getSyncProgress,
    failSyncRun,
    saveCompletedSync,
    getDashboardSnapshot,
    listActivityCatalog,
    listSearchProfiles,
    getEnabledSearchProfile,
    createSearchProfile,
    updateSearchProfile,
    listAttachmentMeta,
    setAttachmentAvailability,
    markAttachmentDownloaded,
    getDownloadApproval,
    requestDownloadApprovalIntent,
    getDownloadApprovalIntent,
    confirmDownloadApprovalIntent,
    consumeDownloadApproval,
    revokeDownloadApproval,
    recordDownloadJob,
    updateDownloadJob,
    listDownloadJobs,
    loadState,
    saveState,
    recordAutomationStatus,
    close: () => database.close(),
  };
}

export { trackedTenderFields };
