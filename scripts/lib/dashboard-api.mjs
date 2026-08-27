// P5-DASH — ملخص آخر جولة مزامنة + إحصاءات المناطق (للرسم البياني)
// قراءة فقط من SQLite — بلا أي أثر كتابة.

function formatArabicDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} ثانية`;
  if (seconds === 0) return `${minutes} دقيقة`;
  return `${minutes} دقيقة و${seconds} ثانية`;
}

export function createDashboardApi({ repository }) {
  function lastRunSummary() {
    const run = repository.getLastCompletedSyncRun();
    if (!run) return null;
    const regions = repository.getSyncRegions(run.id);
    const topRegions = [...regions]
      .sort((a, b) => (b.checked_count ?? 0) - (a.checked_count ?? 0))
      .slice(0, 6)
      .map((r) => ({ name: r.region_name, checked: r.checked_count ?? 0 }));
    const startedAt = Date.parse(run.started_at);
    const finishedAt = Date.parse(run.finished_at);
    return {
      runId: run.id,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      durationMs: Number.isFinite(startedAt) && Number.isFinite(finishedAt) ? finishedAt - startedAt : null,
      durationLabel: Number.isFinite(startedAt) && Number.isFinite(finishedAt) ? formatArabicDuration(finishedAt - startedAt) : null,
      status: run.status,
      regionsTargeted: run.regions_targeted,
      regionsCompleted: run.regions_completed,
      checked: run.checked_count,
      newCount: run.new_count,
      changedCount: run.changed_count,
      errorMessage: run.error_message,
      topRegions,
      complete: run.status === "complete" && run.regions_completed === run.regions_targeted && !run.error_message,
    };
  }

  function regionStats() {
    const rows = repository.getTenderRegionCounts();
    const single = rows.filter((r) => !String(r.region).startsWith("متعدد"));
    const multi = rows.filter((r) => String(r.region).startsWith("متعدد"));
    const multiCount = multi.reduce((sum, r) => sum + r.c, 0);
    return {
      single: single.map((r) => ({ region: r.region, count: r.c })).sort((a, b) => b.count - a.count),
      multiGroups: multi.length,
      multiTenders: multiCount,
      total: single.reduce((sum, r) => sum + r.c, 0) + multiCount,
    };
  }

  function attachmentsOverview() {
    return repository.getAttachmentsStorageOverview();
  }

  return { lastRunSummary, regionStats, attachmentsOverview };
}
