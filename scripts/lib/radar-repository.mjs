import path from "node:path";
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const migrationVersion = 3;
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
      local_path TEXT,
      sha256 TEXT,
      mime_type TEXT,
      size INTEGER,
      UNIQUE (tender_reference, display_name)
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
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      consumed_at TEXT
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
    markInactive: database.prepare("UPDATE tenders SET active = 0"),
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
      INSERT INTO attachments (tender_reference, display_name, kind, remote_visible)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(tender_reference, display_name) DO UPDATE SET
        kind = excluded.kind, remote_visible = 1
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

  function seedBaseline(references) {
    const importedAt = new Date().toISOString();
    transaction(() => {
      for (const reference of references) statements.insertBaseline.run(String(reference), importedAt);
    });
  }

  function listTenders() { return statements.listTenders.all().map(rowToTender); }

  function getTender(reference) {
    const row = statements.getTender.get(reference);
    return row ? rowToTender(row) : null;
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
      return { id: resumable.id, resumed: true, cursor: safeJson(resumable.resume_cursor, initialCursor) };
    }
    const id = startSyncRun({ regions, targetPerRegion });
    statements.updateRunCheckpoint.run(0, 0, JSON.stringify(initialCursor), id);
    return { id, resumed: false, cursor: initialCursor };
  }

  function saveSyncCheckpoint(runId, checkpoint) {
    const savedAt = new Date().toISOString();
    const cursor = checkpoint.nextCursor;
    const regionsCompleted = cursor.complete ? 13 : Math.max(0, Number(cursor.regionIndex || 0));
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
      statements.markInactive.run();
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
    loadState,
    saveState,
    recordAutomationStatus,
    close: () => database.close(),
  };
}

export { trackedTenderFields };
