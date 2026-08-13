export const pageSize = 24;
export const targetPerRegion = 100;

export const regions = [
  { id: "1", name: "منطقة الرياض" },
  { id: "2", name: "منطقة مكة المكرمة" },
  { id: "3", name: "منطقة المدينة المنورة" },
  { id: "4", name: "منطقة القصيم" },
  { id: "5", name: "المنطقة الشرقية" },
  { id: "6", name: "منطقة عسير" },
  { id: "7", name: "منطقة تبوك" },
  { id: "8", name: "منطقة حائل" },
  { id: "9", name: "منطقة الحدود الشمالية" },
  { id: "10", name: "منطقة جازان" },
  { id: "11", name: "منطقة نجران" },
  { id: "12", name: "منطقة الباحة" },
  { id: "13", name: "منطقة الجوف" },
];

export const feeBuckets = [
  { id: "free", value: "0" },
  { id: "paid-1-1000", value: "1" },
];

// الخطة الافتراضية تعيد تمامًا نطاق P1 الحالي: المقاولات، 13 منطقة، مجانية حتى 600، حد 100 لكل منطقة.
export const defaultPlan = {
  scopeKey: "activity:المقاولات|regions:1-13|status:active|fee:0-600|sub:none",
  activityName: "المقاولات",
  activityValue: "2",
  subActivityValues: [],
  platformStatuses: ["المنافسات النشطة (تقديم العروض)"],
  regions,
  feeBuckets,
  targetPerRegion,
  feeMin: 0,
  feeMax: 600,
};

// بناء خطة بحث من Search Profile محفوظ، مع سقوف آمنة وعدم التوسع التلقائي لكل الأنشطة.
export function planFromSearchProfile(profile) {
  if (!profile) return defaultPlan;
  const activityName = String(profile.activityName || "").trim();
  if (!activityName || !profile.activityEtimadValue) {
    const error = new Error("ملف البحث غير جاهز للمزامنة: لم تُسجّل قيمة النشاط الأساسية من اعتماد بعد.");
    error.code = "INVALID_PROFILE";
    throw error;
  }
  const requestedSubNames = Array.isArray(profile.subActivityNames) ? profile.subActivityNames : [];
  const requestedSubValues = Array.isArray(profile.subActivityEtimadValues) ? profile.subActivityEtimadValues.filter(Boolean) : [];
  if (requestedSubNames.length) {
    const error = new Error("ملف البحث محفوظ، لكن مزامنة الأنشطة الفرعية لم تُفعّل بعد حتى لا يُتجاهل الفلتر بصمت.");
    error.code = "INVALID_PROFILE";
    throw error;
  }
  const statuses = Array.isArray(profile.platformStatuses) ? profile.platformStatuses : [];
  if (statuses.length !== 1 || statuses[0] !== "المنافسات النشطة (تقديم العروض)") {
    const error = new Error("المزامنة الحالية تدعم حالة المنافسات النشطة فقط حتى تُربط قيم الحالات الأخرى من اعتماد.");
    error.code = "INVALID_PROFILE";
    throw error;
  }
  const requestedRegionIds = Array.isArray(profile.regionIds) ? profile.regionIds.map(String) : [];
  const planRegions = requestedRegionIds.length
    ? regions.filter((region) => requestedRegionIds.includes(region.id))
    : regions;
  const feeMin = Math.max(0, Math.floor(Number(profile.feeMin) || 0));
  const rawMax = profile.feeMax === null || profile.feeMax === undefined ? 600 : Math.floor(Number(profile.feeMax));
  const feeMax = Number.isFinite(rawMax) ? Math.max(feeMin, rawMax) : 600;
  const buckets = [];
  if (feeMin === 0) buckets.push(feeBuckets[0]);
  if (feeMax >= 1) buckets.push(feeBuckets[1]);
  if (!buckets.length) buckets.push(feeBuckets[0]);
  const requestedTarget = Math.floor(Number(profile.targetPerRegion));
  const scopeKey = JSON.stringify({
    profileId: profile.id || null,
    activityName,
    activityValue: profile.activityEtimadValue,
    subActivityValues: requestedSubValues,
    regionIds: planRegions.map((region) => region.id),
    statuses,
    feeMin,
    feeMax,
    targetPerRegion: Number.isFinite(requestedTarget) ? Math.max(1, Math.min(targetPerRegion, requestedTarget)) : targetPerRegion,
  });
  return {
    scopeKey,
    activityName,
    activityValue: profile.activityEtimadValue,
    subActivityValues: requestedSubValues,
    platformStatuses: statuses,
    regions: planRegions.length ? planRegions : regions,
    feeBuckets: buckets,
    targetPerRegion: Number.isFinite(requestedTarget) ? Math.max(1, Math.min(targetPerRegion, requestedTarget)) : targetPerRegion,
    feeMin,
    feeMax,
  };
}

export function initialCursor(plan = defaultPlan) {
  return {
    scopeKey: plan.scopeKey,
    regionIndex: 0,
    regionId: plan.regions[0].id,
    feeIndex: 0,
    feeBucket: plan.feeBuckets[0].id,
    pageNumber: 1,
    regionChecked: 0,
    checked: 0,
  };
}

export function normalizeCursor(cursor, plan = defaultPlan) {
  if (!cursor || cursor.regionIndex >= plan.regions.length) return initialCursor(plan);
  const regionIndex = Math.max(0, Number(cursor.regionIndex) || 0);
  const feeIndex = Math.max(0, Math.min(plan.feeBuckets.length - 1, Number(cursor.feeIndex) || 0));
  return {
    scopeKey: cursor.scopeKey || plan.scopeKey,
    regionIndex,
    regionId: plan.regions[regionIndex].id,
    feeIndex,
    feeBucket: plan.feeBuckets[feeIndex].id,
    pageNumber: Math.max(1, Number(cursor.pageNumber) || 1),
    regionChecked: Math.max(0, Number(cursor.regionChecked) || 0),
    checked: Math.max(0, Number(cursor.checked) || 0),
    complete: cursor.complete === true,
  };
}

export function advanceCursor(cursor, { batchSize, hasNextPage }, plan = defaultPlan) {
  const current = normalizeCursor(cursor, plan);
  const checked = current.checked + batchSize;
  const regionChecked = current.regionChecked + batchSize;

  if (regionChecked < plan.targetPerRegion && hasNextPage) {
    return { ...current, checked, regionChecked, pageNumber: current.pageNumber + 1 };
  }

  if (regionChecked < plan.targetPerRegion && current.feeIndex + 1 < plan.feeBuckets.length) {
    const feeIndex = current.feeIndex + 1;
    return { ...current, checked, regionChecked, feeIndex, feeBucket: plan.feeBuckets[feeIndex].id, pageNumber: 1 };
  }

  const regionIndex = current.regionIndex + 1;
  if (regionIndex >= plan.regions.length) return { ...current, checked, regionChecked, complete: true };
  return {
    scopeKey: current.scopeKey,
    regionIndex,
    regionId: plan.regions[regionIndex].id,
    feeIndex: 0,
    feeBucket: plan.feeBuckets[0].id,
    pageNumber: 1,
    regionChecked: 0,
    checked,
  };
}

export function mergeTenderAppearances(appearances) {
  const unique = new Map();
  const evidenceRank = { unknown: 0, "card-observed": 1, "detail-verified": 2 };
  for (const item of appearances || []) {
    if (!item?.reference) continue;
    if (!unique.has(item.reference)) unique.set(item.reference, { ...item, regions: [] });
    const current = unique.get(item.reference);
    const incomingRank = evidenceRank[item.feeVerification] ?? 0;
    const currentRank = evidenceRank[current.feeVerification] ?? 0;
    if (item.fee !== null && item.fee !== undefined && incomingRank >= currentRank) {
      current.fee = item.fee;
      current.feeVerification = item.feeVerification || "unknown";
      current.feeRawText = item.feeRawText || null;
    }
    const regionName = item.regionName || item.region;
    if (regionName && !current.regions.includes(regionName)) current.regions.push(regionName);
  }
  return [...unique.values()];
}

export function pagesNeeded(limit = targetPerRegion) {
  return Math.ceil(limit / pageSize);
}
