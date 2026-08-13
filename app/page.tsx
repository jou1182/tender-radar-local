"use client";

import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { demoTenders } from "./demo-tenders";

type TenderStatus = "جديدة" | "قيد المراجعة" | "مناسبة" | "مستبعدة";
type DocumentStatus = "لم تُفتح" | "الكراسة" | "الكراسة + الكميات" | "مكتملة";
type FileKind = "booklet" | "boq" | "conditions" | "penalties" | "localContent" | "evaluation" | "supporting";
type LocalFile = { name: string; size: number };
type CapturedDetails = {
  status: "complete" | "partial" | "failed";
  inspectedAt: string;
  pageTitle: string;
  sourceUrl: string;
  fields: Record<string, string>;
  sections: Array<{ name: string; text: string }>;
  attachments: Array<{ displayName: string; kind: FileKind }>;
  errorMessage?: string;
};
type Review = {
  scopeFit: "غير مقيم" | "مطابق" | "بحاجة مراجعة" | "غير مطابق";
  classification: "غير مقيم" | "مطابق" | "بحاجة مراجعة" | "غير مطابق";
  guarantee: "غير معروف" | "لا يوجد" | "متاح" | "غير متاح";
  specialTerms: "لم تُراجع" | "تمت المراجعة" | "توجد ملاحظة حرجة";
  notes: string;
};
type Tender = {
  id: string;
  title: string;
  agency: string;
  reference: string;
  fee: number;
  region: string;
  deadline: string;
  status: TenderStatus;
  documents: DocumentStatus;
  score: number;
  active?: boolean;
  platformStatus?: string;
  activity?: string;
  subActivity?: string;
  tenderType?: string;
  publishedAt?: string;
  etimadUrl?: string;
  tenderNumber?: string;
  contractDuration?: string;
  guarantee?: string;
  location?: string;
  quantitySummary?: string;
  remoteAttachments?: string[];
  details?: CapturedDetails;
  disclosedCompetitorCount?: number;
  competitorCountSource?: string;
  files?: Partial<Record<FileKind, LocalFile>>;
  review?: Review;
};

type FeeMode = "all" | "free" | "exact" | "range" | "etimad";
type SortMode = "crowding" | "score" | "deadline" | "fee-asc" | "fee-desc";

const initialReview: Review = { scopeFit: "غير مقيم", classification: "غير مقيم", guarantee: "غير معروف", specialTerms: "لم تُراجع", notes: "" };
const demoData = demoTenders.map((tender) => ({ ...tender })) as Tender[];
const statusTone: Record<TenderStatus, string> = { "جديدة": "new", "قيد المراجعة": "review", "مناسبة": "fit", "مستبعدة": "out" };
const fileLabels: Record<FileKind, string> = { booklet: "كراسة الشروط والمواصفات", boq: "جدول الكميات", conditions: "الشروط الخاصة والملاحق", penalties: "الغرامات والجزاءات", localContent: "التفضيل السعري والمحتوى المحلي", evaluation: "معايير التقييم والتأهيل", supporting: "ملفات داعمة أخرى" };
const fileDescriptions: Record<FileKind, string> = { booklet: "الكراسة الرئيسية وملاحق المنافسة", boq: "ملف Excel أو PDF لبنود وكميات المشروع", conditions: "الشروط الخاصة وأي نماذج ملحقة", penalties: "ملف الغرامات والجزاءات المطبق", localContent: "المنتج الوطني ونسب المحتوى المحلي", evaluation: "معايير العروض والتأهيل الفني والمالي", supporting: "أي ملف PDF إضافي ظاهر في اعتماد" };
const fileKinds: FileKind[] = ["booklet", "boq", "penalties", "localContent", "evaluation", "conditions", "supporting"];
const detailTabs = ["المعلومات الأساسية", "العناوين والمواعيد", "التصنيف والتنفيذ", "جدول الكميات", "المرفقات", "معايير التقييم", "المحتوى المحلي"] as const;
type DetailTab = typeof detailTabs[number];
type SyncMeta = { lastSyncAt: string | null; checked: number; newItems: number; regions: number; targetPerRegion: number; requestedAt?: string };
type AutomationStatus = {
  online: boolean;
  configured: boolean;
  state: "waiting" | "ready" | "changes" | "duplicate" | "error";
  message: string;
  workflow?: string;
  syncId?: string;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  counts?: { new: number; changed: number; unchanged: number };
  dryRun?: boolean;
};
type LocalSyncResult = { lastSyncAt: string; checked: number; regions: number; targetPerRegion: number; added: Tender[]; changed: Tender[]; items: Tender[]; automation?: AutomationStatus };
type SyncProgress = {
  id: string;
  status: "running" | "complete" | "partial" | "failed";
  regionsTargeted: number;
  regionsCompleted: number;
  targetPerRegion: number;
  checked: number;
  errorMessage?: string | null;
  cursor?: { pageNumber?: number; feeBucket?: string } | null;
  regions?: Array<{ id: string; name: string; status: string; checked: number }>;
};
const syncServiceUrl = "http://127.0.0.1:4318";
const defaultSyncMeta: SyncMeta = { lastSyncAt: null, checked: 0, newItems: 0, regions: 0, targetPerRegion: 100 };
const defaultAutomation: AutomationStatus = { online: false, configured: true, state: "waiting", message: "بانتظار اختبار ربط n8n المحلي" };
const finalRanking = [
  { id: "260739002979", reason: "أفضل توازن بين الوقت المتاح، عدم وجود ضمان، ووضوح الملفات الداعمة.", scope: "أعمال كهربائية وطاقة شمسية لشواحن المركبات", files: "7 مرفقات ظاهرة" },
  { id: "260839003218", reason: "أقل تزاحم متوقع ونطاق تنفيذي مباشر، لكن الوقت أقصر والملفات غير ظاهرة.", scope: "توريد وتركيب ساتر لحجب الرؤية", files: "لا توجد مرفقات منفصلة ظاهرة" },
  { id: "260839001543", reason: "نطاق مناسب للمقاولات، لكن الإقفال الأقرب يجعل قرار المشاركة عاجلًا.", scope: "فك ونقل وتركيب مظلات مواقف", files: "لا توجد مرفقات منفصلة ظاهرة" },
];
const tenderStatusOptions = ["الكل", "المنافسات النشطة (تقديم العروض)", "المنافسات المنتهية (الكل)", "- مرحلة فتح العروض", "- مرحلة فحص العروض", "- مرحلة الترسية", "- تم إعلان الترسية"];
const regionOptions = ["منطقة الرياض", "منطقة مكة المكرمة", "منطقة المدينة المنورة", "منطقة القصيم", "المنطقة الشرقية", "منطقة عسير", "منطقة تبوك", "منطقة حائل", "منطقة الحدود الشمالية", "منطقة جازان", "منطقة نجران", "منطقة الباحة", "منطقة الجوف"];
const activityOptions = ["التجارة", "المقاولات", "التشغيل والصيانة والنظافة للمنشآت", "العقارات والأراضي", "الصناعة والتعدين والتدوير", "الغاز والمياه والطاقة", "المناجم والبترول والمحاجر", "الإعلام والنشر والتوزيع", "الاتصالات وتقنية المعلومات", "الزراعة والصيد", "الرعاية الصحية والنقاهة", "التعليم والتدريب", "التوظيف والاستقدام", "الأمن والسلامة", "النقل والبريد والتخزين", "المهن الاستشارية", "السياحة والمطاعم والفنادق وتنظيم المعارض", "المالية والتمويل والتأمين", "الخدمات الأخرى"];
const subActivityOptions: Record<string, string[]> = {
  "المقاولات": ["مقاولات الإنشاءات العامة (التشييد وبناء المرافق العامة)", "مقاولات عامة للمباني (الإنشاء، الإصلاح، الهدم، الترميم)", "مقاولات فرعية تخصصية (أنشطة التشييد المتخصصة)", "مقاولات الإنشاءات العامة (التشييد وبناء المرافق العامة) - إنشاء الطرق", "مقاولات الإنشاءات العامة (التشييد وبناء المرافق العامة) - إنشاءات عامة", "مقاولات فرعية تخصصية (أنشطة التشييد المتخصصة) - إنشاء الطرق", "مقاولات فرعية تخصصية (أنشطة التشييد المتخصصة) - إنشاءات عامة"],
};

const tenderTypeOptions = ["الكل", "منافسة عامة", "شراء مباشر", "اتفاقية إطارية", "منافسة محدودة", "منافسة من مرحلتين"];
const publishPeriodOptions = ["في أي وقت", "منذ يومين", "منذ أسبوع", "منذ شهر", "منذ 3 شهور"];
const exactFeePresets = [0, 200, 300, 400, 600, 800, 1000, 1500, 2000];
const etimadFeeBands = [
  { value: "0-1000", label: "1 - 1,000 ر.س", min: 1, max: 1000 },
  { value: "1001-10000", label: "1,001 - 10,000 ر.س", min: 1001, max: 10000 },
  { value: "10001-20000", label: "10,001 - 20,000 ر.س", min: 10001, max: 20000 },
  { value: "20001-40000", label: "20,001 - 40,000 ر.س", min: 20001, max: 40000 },
  { value: "40001-50000", label: "40,001 - 50,000 ر.س", min: 40001, max: 50000 },
  { value: "50001+", label: "أكثر من 50,000 ر.س", min: 50001, max: Number.POSITIVE_INFINITY },
];

function escapeCsv(value: string | number) { return `"${String(value).replaceAll('"', '""')}"`; }
function formatSize(bytes: number) { return bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1024))} ك.ب` : `${(bytes / 1_000_000).toFixed(1)} م.ب`; }
function normalizeArabic(value: string) { return value.trim().toLocaleLowerCase("ar").replaceAll("ـ", ""); }
function regionNeedle(value: string) { return value.replace(/^منطقة\s+/, "").replace(/^المنطقة\s+/, ""); }
function publishedAfter(period: string) {
  const days: Record<string, number> = { "منذ يومين": 2, "منذ أسبوع": 7, "منذ شهر": 30, "منذ 3 شهور": 90 };
  return days[period] ? Date.now() - days[period] * 86_400_000 : null;
}

function getCrowdingSignal(tender: Tender) {
  let score = 52;
  const factors: string[] = [];
  if (tender.tenderType === "شراء مباشر") { score -= 12; factors.push("شراء مباشر بنطاق موردين أضيق عادةً"); }
  if (tender.tenderType === "منافسة عامة") { score += 8; factors.push("منافسة عامة تجذب شريحة أوسع"); }
  if (tender.fee === 0) { score += 10; factors.push("الكراسة المجانية تخفض حاجز الدخول"); }
  else if (tender.fee >= 500) { score -= 7; factors.push("قيمة الكراسة تقلل الدخول العشوائي"); }
  else { score += 3; factors.push("قيمة الكراسة منخفضة نسبيًا"); }
  if (tender.guarantee?.includes("لا يوجد")) { score += 8; factors.push("عدم وجود ضمان يسهّل المشاركة"); }
  else if (tender.guarantee?.includes("ضمان")) { score -= 8; factors.push("الضمان المطلوب يرفع حاجز المشاركة"); }
  if ((tender.remoteAttachments?.length ?? 0) >= 7) { score -= 6; factors.push("كثرة المتطلبات ترفع كلفة التحضير"); }
  if (tender.region.includes("الرياض") || tender.region.includes("مكة") || tender.region.includes("الشرقية")) { score += 5; factors.push("منطقة ذات قاعدة موردين كبيرة"); }
  if (tender.region === "غير محددة") { score -= 4; factors.push("موقع التنفيذ غير واضح بعد"); }
  const deadline = Date.parse(tender.deadline.replace(" ", "T"));
  const daysRemaining = Number.isFinite(deadline) ? Math.ceil((deadline - Date.now()) / 86_400_000) : null;
  if (daysRemaining !== null && daysRemaining <= 5) { score -= 9; factors.push("مهلة التقديم قصيرة"); }
  else if (daysRemaining !== null && daysRemaining >= 18) { score += 5; factors.push("فترة الإعلان طويلة"); }
  score = Math.max(10, Math.min(90, score));
  const level = score <= 38 ? "منخفض" : score <= 62 ? "متوسط" : "مرتفع";
  const label = level === "منخفض" ? "فرصة أهدأ محتملة" : level === "متوسط" ? "تزاحم متوازن" : "تزاحم مرتفع محتمل";
  const confidence = [tender.tenderType, tender.guarantee, tender.region, tender.deadline].filter(Boolean).length >= 4 ? "متوسطة" : "منخفضة";
  return { score, level, label, confidence, factors, daysRemaining };
}

const fileDbName = "tender-radar-files";
function openFileDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(fileDbName, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains("files")) request.result.createObjectStore("files"); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function storeLocalFile(key: string, file: File) {
  const db = await openFileDb();
  await new Promise<void>((resolve, reject) => { const tx = db.transaction("files", "readwrite"); tx.objectStore("files").put(file, key); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  db.close();
}
async function readLocalFile(key: string): Promise<Blob | undefined> {
  const db = await openFileDb();
  const file = await new Promise<Blob | undefined>((resolve, reject) => { const request = db.transaction("files", "readonly").objectStore("files").get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  db.close(); return file;
}

function getAssessment(tender: Tender) {
  const review = tender.review ?? initialReview;
  const missing: string[] = [];
  if (!tender.files?.booklet) missing.push("كراسة الشروط");
  if (!tender.files?.boq) missing.push("جدول الكميات");
  if (!tender.files?.conditions) missing.push("الشروط الخاصة أو الملحق");
  const risks: string[] = [];
  if (review.scopeFit === "غير مطابق") risks.push("نطاق العمل لا يطابق نشاط المنشأة.");
  if (review.classification === "غير مطابق") risks.push("التصنيف أو الأهلية غير مطابقين.");
  if (review.guarantee === "غير متاح") risks.push("الضمان الابتدائي غير متاح.");
  if (review.specialTerms === "توجد ملاحظة حرجة") risks.push("هناك شرط خاص يحتاج قرارًا إداريًا أو قانونيًا.");
  const ready = missing.length === 0 && review.scopeFit === "مطابق" && review.classification === "مطابق" && review.guarantee !== "غير معروف" && review.guarantee !== "غير متاح" && review.specialTerms === "تمت المراجعة";
  const excluded = review.scopeFit === "غير مطابق" || review.classification === "غير مطابق" || review.guarantee === "غير متاح";
  return {
    decision: excluded ? "استبعاد مبدئي" : ready ? "مناسب مبدئيًا" : "مطلوب استكمال",
    tone: excluded ? "danger" : ready ? "success" : "pending",
    missing,
    risks,
    next: excluded ? "وثّق سبب الاستبعاد ولا تشترِ الكراسة قبل مراجعة القرار." : ready ? "ابدأ مراجعة التسعير والتأكد من موعد الإقفال قبل شراء الكراسة أو التقديم." : "ارفع الملفات الناقصة وأكمل تقييم النطاق والتصنيف والضمان والشروط الخاصة.",
  };
}

function RadarLoader({ overlay = false }: { overlay?: boolean }) {
  return <div className={overlay ? "radar-loader radar-loader-overlay" : "radar-loader"} role="status" aria-live="polite"><div className="radar-loader-brand"><div className="radar-loader-mark"><span className="radar-sweep" /><i className="radar-core">ر</i><i className="radar-ring ring-one" /><i className="radar-ring ring-two" /></div><div><b>رادار المنافسات</b><small>نقرأ الإشارة قبل القرار</small></div></div><div className="radar-loader-progress"><span /><span /><span /><span /></div><p>جاري تجهيز أحدث بيانات الرادار…</p></div>;
}

export default function Home() {
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [dataMode, setDataMode] = useState<"live" | "demo">("live");
  const [regions, setRegions] = useState<string[]>([]);
  const [tenderStatus, setTenderStatus] = useState("المنافسات النشطة (تقديم العروض)");
  const [activity, setActivity] = useState("المقاولات");
  const [subActivity, setSubActivity] = useState("");
  const [tenderType, setTenderType] = useState("الكل");
  const [publishPeriod, setPublishPeriod] = useState("منذ 3 شهور");
  const [feeMode, setFeeMode] = useState<FeeMode>("exact");
  const [exactFee, setExactFee] = useState("200");
  const [minFee, setMinFee] = useState("");
  const [maxFee, setMaxFee] = useState("");
  const [etimadBand, setEtimadBand] = useState(etimadFeeBands[0].value);
  const [query, setQuery] = useState("");
  const [referenceQuery, setReferenceQuery] = useState("");
  const [agencyQuery, setAgencyQuery] = useState("");
  const [deadlineFrom, setDeadlineFrom] = useState("");
  const [deadlineTo, setDeadlineTo] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("crowding");
  const [searchSaved, setSearchSaved] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [activeDetailTab, setActiveDetailTab] = useState<DetailTab>("المعلومات الأساسية");
  const [openingFile, setOpeningFile] = useState<FileKind | null>(null);
  const [isInspectingDetails, setIsInspectingDetails] = useState(false);
  const [isInspectingSample, setIsInspectingSample] = useState(false);
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const [remainingMinutes, setRemainingMinutes] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [isBooting, setIsBooting] = useState(true);
  const [syncMeta, setSyncMeta] = useState<SyncMeta>(defaultSyncMeta);
  const [syncState, setSyncState] = useState<"fresh" | "stale" | "pending">("stale");
  const [helperOnline, setHelperOnline] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("الخدمة المحلية جاهزة للتحقق");
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [automation, setAutomation] = useState<AutomationStatus>(defaultAutomation);
  const [isTestingAutomation, setIsTestingAutomation] = useState(false);

  useEffect(() => {
    window.localStorage.removeItem("tender-radar-v3");
    window.localStorage.removeItem("tender-radar-sync-v1");
    window.localStorage.setItem("tender-radar-last-open", new Date().toISOString());
    const bootTimer = window.setTimeout(() => setIsBooting(false), 1200);
    return () => window.clearTimeout(bootTimer);
  }, []);
  useEffect(() => {
    fetch(`${syncServiceUrl}/health`).then((response) => response.ok ? response.json() : Promise.reject()).then(async (health: { state?: { progress?: SyncProgress | null } }) => {
      setHelperOnline(true); setSyncMessage("خدمة المزامنة المحلية وقاعدة SQLite متصلتان");
      if (health.state?.progress && health.state.progress.status !== "complete") setSyncProgress(health.state.progress);
      const response = await fetch(`${syncServiceUrl}/tenders`);
      if (!response.ok) throw new Error("تعذر قراءة قاعدة المنافسات المحلية");
      const snapshot = await response.json() as SyncMeta & { items: Tender[] };
      setDataMode("live");
      setTenders(snapshot.items);
      setSelectedId(snapshot.items[0]?.id ?? "");
      const databaseMeta: SyncMeta = { lastSyncAt: snapshot.lastSyncAt, checked: snapshot.checked, newItems: snapshot.newItems, regions: snapshot.regions, targetPerRegion: snapshot.targetPerRegion };
      setSyncMeta(databaseMeta);
      const ageHours = snapshot.lastSyncAt ? (Date.now() - new Date(snapshot.lastSyncAt).getTime()) / 3_600_000 : Number.POSITIVE_INFINITY;
      setSyncState(ageHours > 4 ? "stale" : "fresh");
    }).catch(() => { setHelperOnline(false); setSyncMessage("شغّل الرادار من ملف تشغيل-الرادار.cmd لتفعيل SQLite والمزامنة المستقلة"); });
    fetch(`${syncServiceUrl}/automation/status`).then((response) => response.ok ? response.json() : Promise.reject()).then((status: AutomationStatus) => setAutomation(status)).catch(() => setAutomation(defaultAutomation));
  }, []);
  useEffect(() => {
    if (!sessionStartedAt) return;
    const update = () => setRemainingMinutes(Math.max(0, Math.ceil((4 * 60_000 - (Date.now() - sessionStartedAt)) / 60_000)));
    update(); const handle = window.setInterval(update, 15_000); return () => window.clearInterval(handle);
  }, [sessionStartedAt]);
  useEffect(() => {
    if (!isSyncing) return;
    const refreshProgress = async () => {
      try {
        const response = await fetch(`${syncServiceUrl}/status`);
        if (!response.ok) return;
        const current = await response.json() as { phase?: string; message?: string; progress?: SyncProgress | null };
        if (current.progress) setSyncProgress(current.progress);
        if (current.message) setSyncMessage(current.message);
      } catch { /* The active sync request reports the final error. */ }
    };
    void refreshProgress();
    const handle = window.setInterval(() => void refreshProgress(), 1200);
    return () => window.clearInterval(handle);
  }, [isSyncing]);

  const filtered = useMemo(() => {
    const textNeedle = normalizeArabic(query);
    const referenceNeedle = normalizeArabic(referenceQuery);
    const agencyNeedle = normalizeArabic(agencyQuery);
    const publishedThreshold = publishedAfter(publishPeriod);
    const selectedBand = etimadFeeBands.find((band) => band.value === etimadBand);
    const rows = tenders.filter((tender) => {
      const searchable = normalizeArabic([tender.title, tender.agency, tender.reference, tender.region, tender.status].join(" "));
      if (textNeedle && !searchable.includes(textNeedle)) return false;
      if (referenceNeedle && !normalizeArabic(tender.reference).includes(referenceNeedle)) return false;
      if (agencyNeedle && !normalizeArabic(tender.agency).includes(agencyNeedle)) return false;
      if (regions.length && !regions.some((region) => normalizeArabic(tender.region).includes(normalizeArabic(regionNeedle(region))))) return false;
      const effectivePlatformStatus = tender.platformStatus ?? "المنافسات النشطة (تقديم العروض)";
      if (tenderStatus !== "الكل" && effectivePlatformStatus !== tenderStatus) return false;
      if (activity && tender.activity && tender.activity !== activity) return false;
      if (subActivity && tender.subActivity && tender.subActivity !== subActivity) return false;
      if (tenderType !== "الكل" && tender.tenderType && tender.tenderType !== tenderType) return false;
      if (publishedThreshold && tender.publishedAt && new Date(tender.publishedAt).getTime() < publishedThreshold) return false;
      if (deadlineFrom && tender.deadline !== "أدخل الموعد" && tender.deadline.slice(0, 10) < deadlineFrom) return false;
      if (deadlineTo && tender.deadline !== "أدخل الموعد" && tender.deadline.slice(0, 10) > deadlineTo) return false;
      if (feeMode === "free" && tender.fee !== 0) return false;
      if (feeMode === "exact" && tender.fee !== (Number(exactFee) || 0)) return false;
      if (feeMode === "range" && minFee && tender.fee < Number(minFee)) return false;
      if (feeMode === "range" && maxFee && tender.fee > Number(maxFee)) return false;
      if (feeMode === "etimad" && selectedBand && (tender.fee < selectedBand.min || tender.fee > selectedBand.max)) return false;
      return true;
    });
    return rows.sort((a, b) => sortMode === "crowding" ? getCrowdingSignal(a).score - getCrowdingSignal(b).score || b.score - a.score : sortMode === "fee-asc" ? a.fee - b.fee : sortMode === "fee-desc" ? b.fee - a.fee : sortMode === "deadline" ? a.deadline.localeCompare(b.deadline) : b.score - a.score);
  }, [activity, agencyQuery, deadlineFrom, deadlineTo, etimadBand, exactFee, feeMode, maxFee, minFee, publishPeriod, query, referenceQuery, regions, sortMode, subActivity, tenderStatus, tenderType, tenders]);
  const selected = tenders.find((tender) => tender.id === selectedId) ?? tenders[0];
  const assessment = selected ? getAssessment(selected) : null;
  const crowdingSignal = selected ? getCrowdingSignal(selected) : null;
  const suitable = filtered.filter((tender) => tender.status === "مناسبة").length;
  const completed = filtered.filter((tender) => tender.files?.booklet && tender.files?.boq && tender.files?.conditions).length;
  const freeTenders = filtered.filter((tender) => tender.fee === 0).length;
  const quietOpportunities = filtered.filter((tender) => getCrowdingSignal(tender).level === "منخفض").length;
  const priorityRanks = new Map([...filtered].sort((a, b) => getCrowdingSignal(a).score - getCrowdingSignal(b).score || b.score - a.score).slice(0, 3).map((tender, index) => [tender.id, index + 1]));
  const finalists = finalRanking.map((rank) => ({ ...rank, tender: tenders.find((tender) => tender.id === rank.id) })).filter((item): item is typeof item & { tender: Tender } => Boolean(item.tender));
  const activeFilterCount = [query, referenceQuery, agencyQuery, regions.length ? "regions" : "", activity, subActivity, tenderType !== "الكل" ? tenderType : "", deadlineFrom, deadlineTo, feeMode !== "all" ? feeMode : ""].filter(Boolean).length;
  const updateTender = (id: string, patch: Partial<Tender>) => setTenders((current) => current.map((tender) => tender.id === id ? { ...tender, ...patch } : tender));

  function showDemoData() {
    const rows = demoData.map((tender) => ({ ...tender, remoteAttachments: tender.remoteAttachments ? [...tender.remoteAttachments] : undefined }));
    setDataMode("demo"); setTenders(rows); setSelectedId(rows[0]?.id ?? "");
  }

  async function returnToLiveData() {
    try {
      const response = await fetch(`${syncServiceUrl}/tenders`);
      if (!response.ok) throw new Error();
      const snapshot = await response.json() as { items: Tender[] };
      setDataMode("live"); setTenders(snapshot.items); setSelectedId(snapshot.items[0]?.id ?? "");
    } catch { setSyncMessage("تعذر قراءة SQLite؛ تأكد أن خدمة الرادار تعمل"); }
  }

  function addTender() {
    const id = Date.now().toString();
    const band = etimadFeeBands.find((item) => item.value === etimadBand);
    const fee = feeMode === "free" ? 0 : feeMode === "exact" ? Number(exactFee) || 0 : feeMode === "range" ? Number(minFee) || 0 : feeMode === "etimad" ? band?.min ?? 0 : 0;
    setTenders((current) => [{ id, title: "فرصة جديدة — أضف الاسم من اعتماد", agency: agencyQuery || "غير محددة", reference: referenceQuery || id, fee, region: regions.length === 1 ? regions[0] : "جميع المناطق", deadline: deadlineTo || "أدخل الموعد", status: "جديدة", documents: "لم تُفتح", score: 50, platformStatus: tenderStatus, activity, subActivity, tenderType: tenderType === "الكل" ? undefined : tenderType }, ...current]);
    setSelectedId(id);
  }

  function resetSearch() {
    setQuery(""); setReferenceQuery(""); setAgencyQuery(""); setRegions([]);
    setTenderStatus("المنافسات النشطة (تقديم العروض)"); setActivity("المقاولات"); setSubActivity("");
    setTenderType("الكل"); setPublishPeriod("منذ 3 شهور"); setDeadlineFrom(""); setDeadlineTo("");
    setFeeMode("all"); setExactFee("200"); setMinFee(""); setMaxFee(""); setEtimadBand(etimadFeeBands[0].value); setSortMode("crowding");
  }

  function saveSearch() {
    window.localStorage.setItem("tender-radar-search-v1", JSON.stringify({ query, referenceQuery, agencyQuery, regions, tenderStatus, activity, subActivity, tenderType, publishPeriod, feeMode, exactFee, minFee, maxFee, etimadBand, deadlineFrom, deadlineTo, sortMode }));
    setSearchSaved(true); window.setTimeout(() => setSearchSaved(false), 1600);
  }
  async function openEtimadSession() {
    setSyncMessage("جارٍ فتح نافذة اعتماد المحلية...");
    try {
      const response = await fetch(`${syncServiceUrl}/session`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "تعذر فتح الجلسة");
      setHelperOnline(true); setSessionStartedAt(Date.now());
      setSyncMessage(result.message || (result.signedIn ? "جلسة اعتماد جاهزة للمزامنة" : "سجّل دخولك بنفسك في Chrome ثم اضغط مزامنة الآن"));
    } catch (error) {
      setHelperOnline(false); setSyncMessage(error instanceof Error ? error.message : "خدمة المزامنة المحلية غير مشغلة");
    }
  }
  async function requestSync(silent = false) {
    if (isSyncing) return;
    const requestedAt = new Date().toISOString();
    const pending = { ...syncMeta, requestedAt };
    setSyncMeta(pending); setSyncState("pending"); setIsSyncing(true);
    if (!silent) setSyncMessage("بدأ فحص اعتماد: 13 منطقة وحتى 100 نتيجة لكل منطقة");
    try {
      const response = await fetch(`${syncServiceUrl}/sync`, { method: "POST" });
      const result = await response.json() as LocalSyncResult & { message?: string; state?: { progress?: SyncProgress | null } };
      if (!response.ok) {
        if (result.state?.progress) setSyncProgress(result.state.progress);
        throw new Error(result.message || "تعذر تنفيذ المزامنة");
      }
      setHelperOnline(true);
      const storedResponse = await fetch(`${syncServiceUrl}/tenders`);
      const stored = storedResponse.ok ? await storedResponse.json() as { items: Tender[] } : { items: result.items };
      setDataMode("live"); setTenders(stored.items); setSelectedId((current) => stored.items.some((item) => item.id === current) ? current : stored.items[0]?.id ?? "");
      const completed: SyncMeta = { lastSyncAt: result.lastSyncAt, checked: result.checked, newItems: result.added.length, regions: result.regions, targetPerRegion: result.targetPerRegion };
      setSyncMeta(completed); setSyncState("fresh");
      setSyncProgress(null);
      if (result.automation) setAutomation(result.automation);
      setSyncMessage(`اكتملت: ${result.added.length} جديدة و${result.changed.length} متغيرة، دون تنزيل ملفات${result.automation?.online ? " · تم تسجيلها في n8n" : ""}`);
    } catch (error) {
      setSyncState("stale");
      setSyncMessage(error instanceof Error ? error.message : "تعذر تنفيذ المزامنة المحلية");
    } finally { setIsSyncing(false); }
  }
  async function testAutomation() {
    if (isTestingAutomation) return;
    setIsTestingAutomation(true);
    setAutomation((current) => ({ ...current, state: "waiting", message: "جارٍ اختبار مسار n8n المحلي..." }));
    try {
      const response = await fetch(`${syncServiceUrl}/automation/test`, { method: "POST" });
      const result = await response.json() as AutomationStatus;
      setAutomation(result);
    } catch {
      setAutomation({ online: false, configured: true, state: "error", message: "تعذر الوصول إلى خدمة الرادار أو n8n المحلي" });
    } finally { setIsTestingAutomation(false); }
  }
  async function inspectVisibleDetails() {
    if (!selected || isInspectingDetails) return;
    setIsInspectingDetails(true);
    setSyncMessage("جارٍ فتح تفاصيل المنافسة وقراءة أسماء المرفقات الظاهرة فقط...");
    try {
      const response = await fetch(`${syncServiceUrl}/details`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference: selected.reference }),
      });
      const result = await response.json() as { attachmentNames?: string[]; message?: string };
      if (!response.ok) throw new Error(result.message || "تعذر فتح تفاصيل المنافسة");
      const storedResponse = await fetch(`${syncServiceUrl}/tenders`);
      if (storedResponse.ok) {
        const stored = await storedResponse.json() as { items: Tender[] };
        setTenders(stored.items);
      }
      setSyncMessage(`تمت قراءة التفاصيل دون تنزيل: ${result.attachmentNames?.length ?? 0} اسم مرفق ظاهر`);
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : "تعذر قراءة تفاصيل المنافسة");
    } finally { setIsInspectingDetails(false); }
  }
  async function inspectDetailsSample() {
    if (isInspectingSample) return;
    const references = tenders.filter((tender) => tender.active !== false && tender.details?.status !== "complete").slice(0, 2).map((tender) => tender.reference);
    if (!references.length) {
      setSyncMessage("لا توجد منافسات جديدة بلا تفاصيل لاختبار العينة عليها.");
      return;
    }
    setIsInspectingSample(true);
    setSyncMessage(`جارٍ اختبار تفاصيل ${references.length} منافسة فقط، دون شراء أو تنزيل ملفات...`);
    try {
      const response = await fetch(`${syncServiceUrl}/details/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ references }),
      });
      const result = await response.json() as { inspected?: number; message?: string };
      if (!response.ok) throw new Error(result.message || "تعذر اختبار عينة التفاصيل");
      const storedResponse = await fetch(`${syncServiceUrl}/tenders`);
      if (storedResponse.ok) {
        const stored = await storedResponse.json() as { items: Tender[] };
        setTenders(stored.items);
      }
      setSyncMessage(`اكتمل اختبار P2: حُفظت تفاصيل ${result.inspected ?? references.length} منافسة وأسماء المرفقات الظاهرة فقط، دون تنزيل أو شراء.`);
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : "تعذر اختبار عينة التفاصيل");
    } finally { setIsInspectingSample(false); }
  }
  async function onFileChange(kind: FileKind, event: ChangeEvent<HTMLInputElement>) {
    if (!selected) return;
    const file = event.target.files?.[0]; if (!file) return;
    await storeLocalFile(`${selected.id}:${kind}`, file);
    const files = { ...selected.files, [kind]: { name: file.name, size: file.size } };
    const coreCount = [files.booklet, files.boq, files.conditions].filter(Boolean).length;
    updateTender(selected.id, { files, documents: coreCount === 3 ? "مكتملة" : coreCount >= 2 ? "الكراسة + الكميات" : coreCount === 1 ? "الكراسة" : "لم تُفتح" });
  }
  async function openStoredFile(kind: FileKind) {
    if (!selected) return;
    setOpeningFile(kind);
    try {
      const blob = await readLocalFile(`${selected.id}:${kind}`);
      if (!blob) return;
      const url = URL.createObjectURL(blob); window.open(url, "_blank", "noopener,noreferrer"); window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } finally { setOpeningFile(null); }
  }
  function openTender(id: string) {
    setSelectedId(id); setActiveDetailTab("المعلومات الأساسية");
    window.requestAnimationFrame(() => document.getElementById("tender-detail")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }
  function updateReview<K extends keyof Review>(key: K, value: Review[K]) { if (selected) updateTender(selected.id, { review: { ...(selected.review ?? initialReview), [key]: value } }); }
  function exportExcelReady() {
    const headers = ["العنوان", "الجهة", "المرجع", "المنطقة", "قيمة الكراسة", "آخر موعد", "الحالة", "الكراسة", "الكميات", "الشروط الخاصة", "قرار مبدئي", "الملاحظات"];
    const rows = filtered.map((tender) => [tender.title, tender.agency, tender.reference, tender.region, tender.fee, tender.deadline, tender.status, tender.files?.booklet?.name ?? "غير مرفوعة", tender.files?.boq?.name ?? "غير مرفوع", tender.files?.conditions?.name ?? "غير مرفوعة", getAssessment(tender).decision, tender.review?.notes ?? ""]);
    const csv = "\uFEFF" + [headers, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); const link = document.createElement("a"); link.href = url; link.download = `رادار-المنافسات-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url);
  }
  function copyReport() {
    if (!selected || !assessment) return;
    const report = `تقرير قرار مبدئي\nالمنافسة: ${selected.title}\nالمرجع: ${selected.reference}\nالقرار: ${assessment.decision}\nالوثائق الناقصة: ${assessment.missing.length ? assessment.missing.join("، ") : "لا يوجد"}\nالمخاطر: ${assessment.risks.length ? assessment.risks.join(" ") : "لا توجد ملاحظة حرجة مسجلة"}\nالخطوة التالية: ${assessment.next}\nملاحظات: ${selected.review?.notes || "—"}`;
    navigator.clipboard.writeText(report).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); });
  }

  return <main>
    {isBooting && <RadarLoader overlay />}
    <section className="hero"><div><p className="eyebrow">منصة قرار محلية · نطاق اعتماد الكامل</p><h1>رادار المنافسات</h1><p className="intro">ابحث بدقة، فرّق بين المجاني والمدفوع بأي قيمة، ثم حوّل كل فرصة إلى قرار واضح قبل الشراء أو التسعير أو التقديم.</p></div><div className="session-card"><span>جلسة عمل اعتماد</span>{sessionStartedAt ? <><strong>{remainingMinutes === 0 ? "سجّل الدخول مجددًا عند الحاجة" : `تنبيه بعد ${remainingMinutes} دقيقة`}</strong><button className="quiet" onClick={() => void openEtimadSession()}>إعادة فتح جلسة اعتماد</button></> : <><strong>{helperOnline ? "الخدمة المحلية متصلة" : "تحتاج تشغيل الرادار"}</strong><button onClick={() => void openEtimadSession()}>فتح جلسة اعتماد</button></>}<a className="etimad-link" href="https://tenders.etimad.sa/Tender/AllSuppliersTenders?PageNumber=1" target="_blank" rel="noreferrer">فتح اعتماد العادي</a><small>تسجيل الدخول يتم داخل اعتماد، ولا نخزّن اسم المستخدم أو كلمة المرور.</small></div></section>
    <section className="operation-center" aria-label="مركز تشغيل الرادار"><div><span className="ready-dot" /> <b>الرادار يعمل محليًا على هذا الجهاز</b><small>بياناتك تبقى محلية، ولا يتم حفظ كلمة مرور اعتماد.</small></div><ol><li><b>1</b> شغّل «تشغيل-الرادار.cmd».</li><li><b>2</b> افتح جلسة اعتماد وسجّل الدخول بنفسك.</li><li><b>3</b> اضغط «مزامنة الآن» دون الحاجة إلى كودكس.</li></ol><button type="button" onClick={() => void openEtimadSession()}>فتح جلسة اعتماد</button></section>
    <section className={`sync-center ${syncState}`} aria-label="مركز مزامنة اعتماد">
      <div className="sync-heading"><div><p className="eyebrow">مركز المزامنة المستقلة</p><h2>زر واحد، بلا وسيط</h2><p>يتصل الرادار بخدمة محلية على جهازك، ويفحص آخر النتائج ويضيف الجديد ويحدّث المتغير منذ آخر مزامنة.</p></div><div className="sync-state"><span className="sync-pulse" /><b>{syncState === "fresh" ? "البيانات حديثة" : syncState === "pending" ? "المزامنة تعمل الآن" : "تحتاج مزامنة"}</b><small>{syncMeta.lastSyncAt ? `آخر مزامنة: ${new Date(syncMeta.lastSyncAt).toLocaleString("ar-SA", { dateStyle: "medium", timeStyle: "short" })}` : "لم تكتمل مزامنة حقيقية بعد"}</small></div></div>
      <div className="sync-stats"><article><strong>{syncMeta.regions}</strong><span>منطقة مستهدفة</span></article><article><strong>{syncMeta.targetPerRegion}</strong><span>منافسة كحد أقصى لكل منطقة</span></article><article><strong>{syncMeta.checked}</strong><span>نتيجة في آخر فحص متاح</span></article><article><strong>{syncMeta.newItems}</strong><span>فرص أُضيفت في آخر جلسة</span></article></div>
      {syncProgress && syncProgress.status !== "complete" && <div className={`sync-progress ${syncProgress.status}`}><div><b>{syncProgress.status === "partial" ? "جولة محفوظة وقابلة للاستئناف" : "تقدم الجولة الحالية"}</b><span>{syncProgress.regionsCompleted} من {syncProgress.regionsTargeted} منطقة · {syncProgress.checked} ظهور مفحوص{syncProgress.cursor?.pageNumber ? ` · الصفحة ${syncProgress.cursor.pageNumber}` : ""}</span></div><progress max={syncProgress.regionsTargeted} value={syncProgress.regionsCompleted} /></div>}
      <div className="sync-actions"><div><b><span className={`helper-dot ${helperOnline ? "online" : "offline"}`} /> {helperOnline ? "الخدمة المحلية متصلة" : "الخدمة المحلية غير متصلة"}</b><span>{syncMessage}</span></div><div className="sync-buttons"><button type="button" className="outline-button" onClick={() => void openEtimadSession()}>فتح جلسة اعتماد</button><button type="button" className="outline-button" disabled={isInspectingSample || isSyncing} onClick={() => void inspectDetailsSample()}>{isInspectingSample ? "جارٍ فحص العينة..." : "اختبار تفاصيل عينة (2)"}</button><button type="button" disabled={isSyncing || isInspectingSample} onClick={() => void requestSync()}>{isSyncing ? "جارٍ فحص المناطق..." : syncProgress?.status === "partial" ? "استئناف المزامنة" : "مزامنة الآن"}</button></div></div>
    </section>
    <section className={`automation-center ${automation.state}`} aria-label="أتمتة n8n المحلية">
      <div className="automation-head"><div><p className="eyebrow">المرحلة الأولى · أتمتة محلية</p><h2>n8n يستقبل ويسجّل التغييرات</h2><p>بيانات المنافسة الأساسية فقط؛ دون كلمات مرور أو ملفات أو ذكاء اصطناعي.</p></div><div className="automation-status"><span className={`helper-dot ${automation.online ? "online" : "offline"}`} /><b>{automation.online ? "n8n متصل" : automation.state === "error" ? "n8n يحتاج مراجعة" : "بانتظار الاختبار"}</b><small>{automation.workflow ?? "Radar Phase 1"}</small></div></div>
      <div className="automation-body"><div className="automation-alert"><b>{automation.state === "changes" ? "تم رصد تغييرات" : automation.state === "duplicate" ? "تم تجاهل تشغيل مكرر" : automation.online ? "الربط جاهز" : "حالة الربط"}</b><span>{automation.message}</span>{automation.lastSuccessAt && <small>آخر استلام ناجح: {new Date(automation.lastSuccessAt).toLocaleString("ar-SA", { dateStyle: "medium", timeStyle: "short" })}</small>}</div><div className="automation-counts"><article><strong>{automation.counts?.new ?? 0}</strong><span>جديدة</span></article><article><strong>{automation.counts?.changed ?? 0}</strong><span>متغيرة</span></article><article><strong>{automation.counts?.unchanged ?? 0}</strong><span>بلا تغيير</span></article></div><button type="button" onClick={() => void testAutomation()} disabled={isTestingAutomation}>{isTestingAutomation ? "جارٍ الاختبار..." : "اختبار ربط n8n"}</button></div>
    </section>
    <section className="search-studio" aria-label="البحث المتقدم في المنافسات">
      <div className="search-studio-head">
        <div><p className="eyebrow">محرك الرصد المتقدم</p><h2>ابحث بطريقتك، لا بطريقة المنصة</h2><p>نفس نطاق اعتماد، لكن بمعايير أوضح وسعر كراسة بالقيمة الدقيقة أو بالنطاق.</p></div>
        <div className="search-tools"><span>{activeFilterCount} معيار نشط</span><button type="button" onClick={saveSearch}>{searchSaved ? "تم حفظ البحث" : "حفظ البحث"}</button><button type="button" className="outline-button" onClick={resetSearch}>مسح الكل</button></div>
      </div>

      <div className="search-grid search-grid-basic">
        <label>بحث شامل<input placeholder="اسم المنافسة أو كلمة من الوصف" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <label>الرقم المرجعي<input inputMode="numeric" placeholder="مثال: 2608..." value={referenceQuery} onChange={(event) => setReferenceQuery(event.target.value)} /></label>
        <label>الجهة الحكومية<input placeholder="اكتب اسم الجهة" value={agencyQuery} onChange={(event) => setAgencyQuery(event.target.value)} /></label>
        <label>حالة المنافسة<select value={tenderStatus} onChange={(event) => setTenderStatus(event.target.value)}>{tenderStatusOptions.map((option) => <option key={option}>{option}</option>)}</select></label>
      </div>

      <div className="search-grid search-grid-advanced">
        <label>النشاط الأساسي<select value={activity} onChange={(event) => { setActivity(event.target.value); setSubActivity(""); }}><option value="">جميع الأنشطة</option>{activityOptions.map((option) => <option key={option}>{option}</option>)}</select></label>
        <label>النشاط الفرعي<select value={subActivity} disabled={!activity} onChange={(event) => setSubActivity(event.target.value)}><option value="">{activity ? "كل الأنشطة الفرعية" : "اختر النشاط الأساسي أولًا"}</option>{(subActivityOptions[activity] ?? []).map((option) => <option key={option}>{option}</option>)}</select></label>
        <label>نوع المنافسة<select value={tenderType} onChange={(event) => setTenderType(event.target.value)}>{tenderTypeOptions.map((option) => <option key={option}>{option}</option>)}</select></label>
        <label>تاريخ النشر<select value={publishPeriod} onChange={(event) => setPublishPeriod(event.target.value)}>{publishPeriodOptions.map((option) => <option key={option}>{option}</option>)}</select></label>
      </div>

      <div className="region-panel">
        <div className="panel-title"><div><b>المناطق</b><small>عدم الاختيار يعني جميع مناطق المملكة</small></div>{regions.length > 0 && <button type="button" onClick={() => setRegions([])}>إلغاء تحديد المناطق</button>}</div>
        <div className="region-chips">{regionOptions.map((region) => <button type="button" key={region} className={regions.includes(region) ? "active" : ""} aria-pressed={regions.includes(region)} onClick={() => setRegions((current) => current.includes(region) ? current.filter((item) => item !== region) : [...current, region])}>{region}</button>)}</div>
      </div>

      <div className="fee-panel">
        <div className="panel-title"><div><b>قيمة كراسة الشروط</b><small>فلترة أدق من اعتماد: قيمة محددة أو نطاق مخصص أو نطاقات المنصة</small></div></div>
        <div className="fee-mode-tabs">
          {([['all','كل الأسعار'],['free','مجانية'],['exact','قيمة محددة'],['range','نطاق مخصص'],['etimad','نطاقات اعتماد']] as [FeeMode,string][]).map(([value,label]) => <button type="button" key={value} className={feeMode === value ? "active" : ""} onClick={() => setFeeMode(value)}>{label}</button>)}
        </div>
        {feeMode === "exact" && <div className="fee-exact"><div className="fee-presets">{exactFeePresets.map((value) => <button type="button" key={value} className={Number(exactFee) === value ? "active" : ""} onClick={() => setExactFee(String(value))}>{value === 0 ? "مجانية" : `${value} ر.س`}</button>)}</div><label>قيمة أخرى<input type="number" min="0" step="1" value={exactFee} onChange={(event) => setExactFee(event.target.value)} /></label></div>}
        {feeMode === "range" && <div className="range-fields"><label>من سعر<input type="number" min="0" placeholder="0" value={minFee} onChange={(event) => setMinFee(event.target.value)} /></label><span>إلى</span><label>حتى سعر<input type="number" min="0" placeholder="مثال: 600" value={maxFee} onChange={(event) => setMaxFee(event.target.value)} /></label></div>}
        {feeMode === "etimad" && <label className="band-select">النطاق الرسمي في اعتماد<select value={etimadBand} onChange={(event) => setEtimadBand(event.target.value)}>{etimadFeeBands.map((band) => <option key={band.value} value={band.value}>{band.label}</option>)}</select></label>}
        {feeMode === "free" && <p className="filter-hint">سيظهر فقط ما كانت قيمة وثائقه صفر ريال.</p>}
        {feeMode === "all" && <p className="filter-hint">ستظهر المجانية والمدفوعة، دون تنفيذ شراء أو تنزيل.</p>}
      </div>

      <div className="search-footer">
        <div className="date-range"><label>آخر موعد من<input type="date" value={deadlineFrom} onChange={(event) => setDeadlineFrom(event.target.value)} /></label><label>حتى<input type="date" value={deadlineTo} onChange={(event) => setDeadlineTo(event.target.value)} /></label></div>
        <div className="result-pulse"><strong>{filtered.length}</strong><span>نتيجة مطابقة الآن</span><small>الفلترة فورية على الفرص المحفوظة في الرادار</small></div>
        <button className="primary add-opportunity" type="button" onClick={addTender}>إضافة فرصة بهذه المعايير</button>
      </div>
    </section>

    <section className="metrics"><article><span>النتائج المطابقة</span><strong>{filtered.length}</strong><small>من أصل {tenders.length} فرصة محفوظة</small></article><article><span>مجانية ضمن النتائج</span><strong>{freeTenders}</strong><small>قيمة الكراسة صفر ريال</small></article><article><span>فرص أهدأ تقديريًا</span><strong>{quietOpportunities}</strong><small>تزاحم متوقع منخفض — ليس عددًا رسميًا</small></article><article><span>مناسبة مبدئيًا</span><strong>{suitable}</strong><small>بحسب تقييم الرادار</small></article><article><span>ملفات مكتملة</span><strong>{completed}</strong><small>كراسة + كميات + شروط</small></article></section>

    <section className="comparison-board">
      <div className="comparison-head"><div><p className="eyebrow">المقارنة النهائية</p><h2>أفضل ثلاث فرص قبل أي شراء أو تنزيل</h2></div><span>الترتيب يجمع الوقت والضمان والنطاق ووضوح الملفات، وليس التزاحم وحده.</span></div>
      <div className="comparison-grid">{finalists.map((item, index) => <article key={item.id} className={index === 0 ? "winner" : ""}><div className="rank-medal">{index + 1}</div><div className="comparison-title"><span>{item.tender.reference}</span><h3>{item.tender.title}</h3><small>{item.tender.agency}</small></div><dl><div><dt>آخر موعد</dt><dd>{item.tender.deadline}</dd></div><div><dt>الضمان</dt><dd>{item.tender.guarantee ?? "غير معروف"}</dd></div><div><dt>نطاق العمل</dt><dd>{item.scope}</dd></div><div><dt>الملفات الظاهرة</dt><dd>{item.files}</dd></div></dl><p>{item.reason}</p><button type="button" onClick={() => openTender(item.id)}>فتح مركز المنافسة</button></article>)}</div>
    </section>

    <section className="workbench">
      <div className="section-head"><div><p className="eyebrow">قائمة العمل</p><h2>الفرص المطابقة للبحث</h2><p className="section-note">النتائج مرتبة وقابلة للتصدير حسب الفلاتر الحالية.</p></div><div className="actions"><select aria-label="ترتيب النتائج" value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}><option value="crowding">الأقل تزاحمًا</option><option value="score">الأعلى ملاءمة</option><option value="deadline">الأقرب موعدًا</option><option value="fee-asc">الأقل سعرًا</option><option value="fee-desc">الأعلى سعرًا</option></select><button onClick={exportExcelReady}>تصدير النتائج لـ Excel</button></div></div>
      <div className={`data-source-notice ${dataMode}`}><div><b>{dataMode === "live" ? "بيانات تشغيل حقيقية من SQLite" : "وضع عرض تجريبي — ليست بيانات اعتماد"}</b><span>{dataMode === "live" ? "لا تختلط أمثلة الواجهة بالمنافسات التي تحفظها المزامنة." : "هذه السجلات الثلاثة اصطناعية لاختبار شكل الواجهة فقط."}</span></div>{dataMode === "live" ? <button type="button" onClick={showDemoData}>عرض بيانات تجريبية</button> : <button type="button" onClick={() => void returnToLiveData()}>العودة إلى SQLite</button>}</div>
      <div className="table-wrap"><table><thead><tr><th>المنافسة</th><th>المنطقة</th><th>الكراسة</th><th>إتاحة الكراسة</th><th>الموعد</th><th>التزاحم المتوقع</th><th>الوثائق</th><th>الحالة</th><th>الملاءمة</th></tr></thead><tbody>{filtered.map((tender) => <tr className={tender.id === selected?.id ? "selected-row" : ""} key={tender.id} onClick={() => openTender(tender.id)}><td>{priorityRanks.has(tender.id) && <span className="priority-rank">أفضل {priorityRanks.get(tender.id)}</span>}<strong>{tender.title}</strong><small>{tender.agency} · {tender.reference}</small></td><td>{tender.region}</td><td><b className="fee-value">{tender.fee === 0 ? "مجانية" : `${tender.fee.toLocaleString('ar-SA')} ر.س`}</b></td><td>{tender.fee === 0 ? <span className="free-badge">مجانية</span> : <span className="approval-badge">تحتاج موافقة</span>}</td><td>{tender.deadline}</td><td><span className={`crowding-badge ${getCrowdingSignal(tender).level === "منخفض" ? "low" : getCrowdingSignal(tender).level === "متوسط" ? "medium" : "high"}`}>{getCrowdingSignal(tender).level}</span><small>{getCrowdingSignal(tender).score}/100 تقديري</small></td><td><select aria-label={`وثائق ${tender.title}`} value={tender.documents} onClick={(event) => event.stopPropagation()} onChange={(event) => updateTender(tender.id, { documents: event.target.value as DocumentStatus })}><option>لم تُفتح</option><option>الكراسة</option><option>الكراسة + الكميات</option><option>مكتملة</option></select></td><td><select className={statusTone[tender.status]} aria-label={`حالة ${tender.title}`} value={tender.status} onClick={(event) => event.stopPropagation()} onChange={(event) => updateTender(tender.id, { status: event.target.value as TenderStatus })}><option>جديدة</option><option>قيد المراجعة</option><option>مناسبة</option><option>مستبعدة</option></select></td><td><span className="score">{tender.score}/100</span></td></tr>)}{filtered.length === 0 && <tr><td colSpan={9} className="empty"><b>لا توجد نتائج بهذه المعايير.</b><span>جرّب «كل الأسعار»، أو امسح تحديد المناطق، أو وسّع نطاق قيمة الكراسة.</span><button type="button" onClick={resetSearch}>مسح الفلاتر</button></td></tr>}</tbody></table></div>
    </section>
    {selected && assessment && crowdingSignal ? <>
    <section id="tender-detail" className="tender-detail-hub">
      <div className="detail-hero">
        <div><p className="eyebrow">مركز المنافسة الموحد</p><span className="detail-reference">{selected.reference}</span><h2>{selected.title}</h2><p>{selected.agency}</p></div>
        <div className="detail-hero-actions"><span className={selected.fee === 0 ? "free-badge" : "approval-badge"}>{selected.fee === 0 ? "كراسة مجانية" : `الكراسة ${selected.fee.toLocaleString('ar-SA')} ر.س`}</span><button type="button" onClick={() => void inspectVisibleDetails()} disabled={isInspectingDetails}>{isInspectingDetails ? "جارٍ قراءة التفاصيل..." : "قراءة التفاصيل دون تنزيل"}</button><a href={selected.etimadUrl ?? "https://tenders.etimad.sa/Tender/AllSuppliersTenders?PageNumber=1"} target="_blank" rel="noreferrer">عرض المصدر في اعتماد</a></div>
      </div>
      <nav className="detail-tabs" aria-label="أقسام تفاصيل المنافسة">{detailTabs.map((tab) => <button type="button" key={tab} className={activeDetailTab === tab ? "active" : ""} aria-current={activeDetailTab === tab ? "page" : undefined} onClick={() => setActiveDetailTab(tab)}><span>{tab === "المرفقات" ? "📎" : tab === "جدول الكميات" ? "▦" : tab === "العناوين والمواعيد" ? "◷" : "▪"}</span>{tab}</button>)}</nav>
      <div className="market-intelligence">
        <div className="market-title"><p className="eyebrow">ذكاء المنافسة</p><h3>{crowdingSignal.label}</h3><span>ثقة التقدير: {crowdingSignal.confidence}</span></div>
        <div className="crowding-meter"><div><span style={{ width: `${crowdingSignal.score}%` }} /></div><b>{crowdingSignal.score}/100</b><small>كلما ارتفع المؤشر زاد التزاحم المتوقع</small></div>
        <div className="official-count"><span>عدد المشترين أو المتقدمين الحقيقي</span><strong>{selected.disclosedCompetitorCount ?? "غير متاح"}</strong><small>{selected.competitorCountSource ?? "لا تعرضه اعتماد لحساب المورد أثناء المنافسة النشطة"}</small></div>
        <div className="signal-factors">{crowdingSignal.factors.slice(0, 4).map((factor) => <span key={factor}>• {factor}</span>)}</div>
      </div>
      <div className="detail-body">
        {activeDetailTab === "المعلومات الأساسية" && <div className="detail-facts"><article><span>الرقم المرجعي</span><b>{selected.reference}</b></article><article><span>رقم المنافسة</span><b>{selected.tenderNumber ?? "غير مسجل"}</b></article><article><span>نوع المنافسة</span><b>{selected.tenderType ?? "غير مسجل"}</b></article><article><span>حالة المنافسة</span><b>{selected.platformStatus ?? "المنافسات النشطة (تقديم العروض)"}</b></article><article><span>المنطقة</span><b>{selected.region}</b></article><article><span>قيمة الوثائق</span><b>{selected.fee === 0 ? "مجانية" : `${selected.fee.toLocaleString('ar-SA')} ر.س`}</b></article></div>}
        {activeDetailTab === "العناوين والمواعيد" && <div className="detail-facts"><article><span>موقع التنفيذ</span><b>{selected.location ?? selected.region}</b></article><article><span>آخر موعد لتقديم العروض</span><b>{selected.deadline}</b></article><article><span>تاريخ النشر</span><b>{selected.publishedAt ?? "غير مسجل"}</b></article><article><span>مدة العقد</span><b>{selected.contractDuration ?? "غير مسجلة"}</b></article></div>}
        {activeDetailTab === "التصنيف والتنفيذ" && <div className="detail-facts"><article><span>النشاط الأساسي</span><b>{selected.activity ?? "غير مصنف"}</b></article><article><span>النشاط الفرعي</span><b>{selected.subActivity ?? "غير مسجل"}</b></article><article><span>الضمان الابتدائي</span><b>{selected.guarantee ?? "غير معروف"}</b></article><article><span>حالة الملاءمة</span><b>{selected.score}/100</b></article></div>}
        {activeDetailTab === "جدول الكميات" && <div className="single-file-focus"><div><p className="eyebrow">ملف التسعير</p><h3>{fileLabels.boq}</h3><p>{fileDescriptions.boq}</p>{selected.quantitySummary && <span className="source-available">ظاهر في اعتماد: {selected.quantitySummary}</span>}</div>{selected.files?.boq ? <div className="stored-file"><span><b>{selected.files.boq.name}</b><small>{formatSize(selected.files.boq.size)} · محفوظ محليًا</small></span><button type="button" onClick={() => openStoredFile("boq")}>{openingFile === "boq" ? "جارٍ الفتح..." : "فتح الملف"}</button></div> : <label className="upload-cta">إضافة جدول الكميات بعد موافقتك<input type="file" accept=".pdf,.xlsx,.xls" onChange={(event) => onFileChange("boq", event)} /></label>}</div>}
        {activeDetailTab === "المرفقات" && <div className="attachments-workspace">{selected.remoteAttachments?.length ? <div className="remote-files"><div><p className="eyebrow">رُصدت في اعتماد — لم تُنزّل</p><h3>{selected.remoteAttachments.length} ملفات داعمة متاحة</h3></div><div>{selected.remoteAttachments.map((name) => <span key={name}>📄 {name}</span>)}</div></div> : <div className="remote-files empty-remote"><b>لم تظهر ملفات داعمة منفصلة في صفحة اعتماد.</b><span>قد تتاح الملفات بعد شراء الكراسة أو الانضمام للمنافسة.</span></div>}<div className="attachments-grid">{fileKinds.map((kind) => <article className="attachment-card" key={kind}><div className="attachment-icon">{selected.files?.[kind] ? "✓" : "+"}</div><div><h3>{fileLabels[kind]}</h3><p>{fileDescriptions[kind]}</p>{selected.files?.[kind] && <small>{selected.files[kind]?.name} · {formatSize(selected.files[kind]?.size ?? 0)}</small>}</div><div className="attachment-actions">{selected.files?.[kind] && <button type="button" onClick={() => openStoredFile(kind)}>{openingFile === kind ? "جارٍ الفتح..." : "فتح"}</button>}<label>{selected.files?.[kind] ? "استبدال" : "إضافة ملف"}<input type="file" accept={kind === "boq" ? ".pdf,.xlsx,.xls" : ".pdf,.doc,.docx"} onChange={(event) => onFileChange(kind, event)} /></label></div></article>)}</div></div>}
        {activeDetailTab === "معايير التقييم" && <div className="criteria-panel"><div><p className="eyebrow">قرار المشاركة</p><h3>{assessment.decision}</h3><p>{assessment.next}</p></div><div className="criteria-score"><strong>{selected.score}</strong><span>من 100</span></div>{selected.files?.evaluation ? <button type="button" onClick={() => openStoredFile("evaluation")}>فتح ملف معايير التقييم</button> : <label className="upload-cta">إضافة ملف معايير التقييم<input type="file" accept=".pdf,.doc,.docx" onChange={(event) => onFileChange("evaluation", event)} /></label>}</div>}
        {activeDetailTab === "المحتوى المحلي" && <div className="single-file-focus"><div><p className="eyebrow">التفضيل السعري</p><h3>{fileLabels.localContent}</h3><p>{fileDescriptions.localContent}</p></div>{selected.files?.localContent ? <div className="stored-file"><span><b>{selected.files.localContent.name}</b><small>{formatSize(selected.files.localContent.size)} · محفوظ محليًا</small></span><button type="button" onClick={() => openStoredFile("localContent")}>فتح الملف</button></div> : <label className="upload-cta">إضافة ملف المحتوى المحلي<input type="file" accept=".pdf,.doc,.docx" onChange={(event) => onFileChange("localContent", event)} /></label>}</div>}
        {selected.details && <section className="captured-details" aria-label="البيانات المحفوظة من صفحة اعتماد"><div><p className="eyebrow">رصد P2 محفوظ في SQLite</p><h3>{selected.details.sections.length} أقسام ظاهرة · {selected.details.attachments.length} أسماء مرفقات</h3><small>آخر قراءة: {new Date(selected.details.inspectedAt).toLocaleString("ar-SA", { dateStyle: "medium", timeStyle: "short" })} · دون تنزيل أو شراء</small></div><div className="captured-sections">{selected.details.sections.map((section, index) => <details key={`${section.name}-${index}`}><summary>{section.name}</summary><pre>{section.text}</pre></details>)}</div></section>}
      </div>
      <div className="detail-safety"><b>قاعدة الرادار:</b> يعرض تفاصيل المنافسة وملفاتها المحفوظة محليًا. أي شراء أو تنزيل من اعتماد يظل متوقفًا حتى موافقتك الصريحة.</div>
    </section>
    <section className="analysis-workspace"><div className="analysis-head"><div><p className="eyebrow">مرحلة التحليل</p><h2>ملف القرار للمنافسة</h2></div><select aria-label="اختر المنافسة للتحليل" value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>{tenders.map((tender) => <option key={tender.id} value={tender.id}>{tender.reference} — {tender.title}</option>)}</select></div>
      <div className="analysis-grid"><div className="document-panel"><p className="tender-label">{selected.reference}</p><h3>{selected.title}</h3><p className="muted">ارفع نسخة الملف الذي نزلته من اعتماد. يحتفظ الرادار باسم الملف وحالته محليًا، ثم أرفق نفس الملف هنا في المحادثة لتحليل محتواه.</p>{(["booklet", "boq", "conditions"] as FileKind[]).map((kind) => <label className="file-slot" key={kind}><span><b>{fileLabels[kind]}</b>{selected.files?.[kind] ? <small>{selected.files[kind]?.name} · {formatSize(selected.files[kind]?.size ?? 0)}</small> : <small>لم يُرفَع بعد</small>}</span><input type="file" accept=".pdf,.xlsx,.xls,.doc,.docx" onChange={(event) => onFileChange(kind, event)} /></label>)}<div className="file-note">المرفق في الرادار لا يرسل الملف إلى الإنترنت. لإجراء قراءة فعلية للكراسة، أرفقه لي في هذه المحادثة أيضًا.</div></div>
        <div className="review-panel"><h3>مراجعة أولية</h3><div className="review-grid"><label>مطابقة نطاق العمل<select value={(selected.review ?? initialReview).scopeFit} onChange={(event) => updateReview("scopeFit", event.target.value as Review["scopeFit"])}><option>غير مقيم</option><option>مطابق</option><option>بحاجة مراجعة</option><option>غير مطابق</option></select></label><label>التصنيف والأهلية<select value={(selected.review ?? initialReview).classification} onChange={(event) => updateReview("classification", event.target.value as Review["classification"])}><option>غير مقيم</option><option>مطابق</option><option>بحاجة مراجعة</option><option>غير مطابق</option></select></label><label>الضمان الابتدائي<select value={(selected.review ?? initialReview).guarantee} onChange={(event) => updateReview("guarantee", event.target.value as Review["guarantee"])}><option>غير معروف</option><option>لا يوجد</option><option>متاح</option><option>غير متاح</option></select></label><label>الشروط الخاصة<select value={(selected.review ?? initialReview).specialTerms} onChange={(event) => updateReview("specialTerms", event.target.value as Review["specialTerms"])}><option>لم تُراجع</option><option>تمت المراجعة</option><option>توجد ملاحظة حرجة</option></select></label></div><label className="notes">ملاحظاتك أو خلاصة الفحص<textarea placeholder="مثلًا: زيارة موقع إلزامية، تصنيف مطلوب، أو بند تسعير غير واضح." value={(selected.review ?? initialReview).notes} onChange={(event) => updateReview("notes", event.target.value)} /></label></div>
        <div className={`decision-card ${assessment.tone}`}><p>قرار الرادار المبدئي</p><h3>{assessment.decision}</h3><div><b>الوثائق الناقصة</b><span>{assessment.missing.length ? assessment.missing.join("، ") : "لا يوجد"}</span></div><div><b>المخاطر</b><span>{assessment.risks.length ? assessment.risks.join(" ") : "لا توجد ملاحظة حرجة مسجلة"}</span></div><div><b>الخطوة التالية</b><span>{assessment.next}</span></div><button onClick={copyReport}>{copied ? "تم نسخ التقرير" : "نسخ تقرير القرار"}</button></div></div></section>
    </> : <section className="empty-database"><p className="eyebrow">قاعدة المنافسات</p><h2>لا توجد منافسات حقيقية محفوظة بعد</h2><p>شغّل الخدمة المحلية وابدأ أول مزامنة، أو افتح وضع العرض لتجربة شكل الرادار دون خلط الأمثلة ببيانات اعتماد.</p><div><button type="button" onClick={showDemoData}>عرض بيانات تجريبية</button><button type="button" className="outline-button" onClick={() => void openEtimadSession()}>فتح جلسة اعتماد</button></div></section>}
    <section className="flow"><div><p className="eyebrow">طريقة التشغيل اليومية</p><h2>جلسة واضحة، بلا تخمين</h2></div><ol><li><b>1</b><span>تسجّل دخولك أنت إلى اعتماد في Chrome، ثم تبدأ مؤقت الجلسة.</span></li><li><b>2</b><span>نبحث بالفلاتر ونضيف فقط الفرص التي تستحق المتابعة.</span></li><li><b>3</b><span>بعد موافقتك: نحمّل الكراسة والكميات، ثم ترفع الملفات هنا وفي المحادثة للتحليل.</span></li><li><b>4</b><span>نراجع تقرير القرار، ثم نصدر Excel قبل أي إجراء مالي أو تقديم عرض.</span></li></ol></section>
  </main>;
}
