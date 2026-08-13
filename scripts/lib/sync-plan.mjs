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

export function initialCursor() {
  return {
    regionIndex: 0,
    regionId: regions[0].id,
    feeIndex: 0,
    feeBucket: feeBuckets[0].id,
    pageNumber: 1,
    regionChecked: 0,
    checked: 0,
  };
}

export function normalizeCursor(cursor) {
  if (!cursor || cursor.regionIndex >= regions.length) return initialCursor();
  const regionIndex = Math.max(0, Number(cursor.regionIndex) || 0);
  const feeIndex = Math.max(0, Math.min(feeBuckets.length - 1, Number(cursor.feeIndex) || 0));
  return {
    regionIndex,
    regionId: regions[regionIndex].id,
    feeIndex,
    feeBucket: feeBuckets[feeIndex].id,
    pageNumber: Math.max(1, Number(cursor.pageNumber) || 1),
    regionChecked: Math.max(0, Number(cursor.regionChecked) || 0),
    checked: Math.max(0, Number(cursor.checked) || 0),
    complete: cursor.complete === true,
  };
}

export function advanceCursor(cursor, { batchSize, hasNextPage }) {
  const current = normalizeCursor(cursor);
  const checked = current.checked + batchSize;
  const regionChecked = current.regionChecked + batchSize;

  if (regionChecked < targetPerRegion && hasNextPage) {
    return { ...current, checked, regionChecked, pageNumber: current.pageNumber + 1 };
  }

  if (regionChecked < targetPerRegion && current.feeIndex + 1 < feeBuckets.length) {
    const feeIndex = current.feeIndex + 1;
    return { ...current, checked, regionChecked, feeIndex, feeBucket: feeBuckets[feeIndex].id, pageNumber: 1 };
  }

  const regionIndex = current.regionIndex + 1;
  if (regionIndex >= regions.length) return { ...current, checked, regionChecked, complete: true };
  return {
    regionIndex,
    regionId: regions[regionIndex].id,
    feeIndex: 0,
    feeBucket: feeBuckets[0].id,
    pageNumber: 1,
    regionChecked: 0,
    checked,
  };
}

export function mergeTenderAppearances(appearances) {
  const unique = new Map();
  for (const item of appearances) {
    if (!item?.reference) continue;
    if (!unique.has(item.reference)) unique.set(item.reference, { ...item, regions: [] });
    const current = unique.get(item.reference);
    const regionName = item.regionName || item.region;
    if (regionName && !current.regions.includes(regionName)) current.regions.push(regionName);
  }
  return [...unique.values()];
}

export function pagesNeeded(limit = targetPerRegion) {
  return Math.ceil(limit / pageSize);
}
