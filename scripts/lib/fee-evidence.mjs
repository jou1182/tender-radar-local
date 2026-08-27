// P3-B1B0: لا تُعد المنافسة مجانية إلا بصفر مقروء من صفحة تفاصيل اعتماد موثوقة.
export const feeVerificationStates = ["unknown", "card-observed", "detail-verified"];

const arabicIndicDigitMap = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
};

export function normalizeFeeText(value) {
  return String(value ?? "")
    .replace(/[٠-٩]/g, (digit) => arabicIndicDigitMap[digit] || digit)
    .replace(/٫/g, ".")
    .replace(/٬/g, ",")
    .replace(/[‎‏‪-‮]/g, "")
    .trim();
}

export function parseFeeEvidence(rawText) {
  const text = normalizeFeeText(rawText);
  if (!text || /(?:^|\s)[−-]\s*\d/.test(text)) return null;
  const matches = [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((match) => match[0]);
  if (!matches.length) return null;
  const values = matches.map((token) => Number(token.replaceAll(",", "")));
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return null;
  const distinct = [...new Set(values)];
  if (distinct.length !== 1) return null;
  return { value: distinct[0], normalizedText: text };
}

export function isTrustedEtimadDetailsUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "tenders.etimad.sa") return false;
  return /^\/tender\/details(?:forsupplier)?(?:\/|$)/i.test(parsed.pathname);
}

export function cardFeeEvidence(feeText) {
  const rawText = String(feeText || "").trim();
  const parsed = parseFeeEvidence(rawText);
  if (!parsed) return { fee: null, feeVerification: "unknown", feeRawText: rawText || null };
  return { fee: parsed.value, feeVerification: "card-observed", feeRawText: rawText };
}

export function feeEvidenceRank(verification) {
  const rank = feeVerificationStates.indexOf(String(verification || "unknown"));
  return rank < 0 ? 0 : rank;
}

export function mergeSyncFeeEvidence(previous, incoming) {
  const previousFee = Number(previous?.fee);
  const prev = {
    fee: Number.isFinite(previousFee) && previousFee >= 0 ? previousFee : 0,
    feeVerification: feeVerificationStates.includes(previous?.feeVerification) ? previous.feeVerification : "unknown",
    feeRawText: previous?.feeRawText || null,
  };
  if (!previous) {
    return incoming?.feeVerification === "unknown"
      ? { fee: 0, feeVerification: "unknown", feeRawText: incoming?.feeRawText || null }
      : { fee: incoming?.fee ?? 0, feeVerification: incoming?.feeVerification || "unknown", feeRawText: incoming?.feeRawText || null };
  }
  const incomingRank = feeEvidenceRank(incoming?.feeVerification);
  const previousRank = feeEvidenceRank(prev.feeVerification);
  if (incoming?.feeVerification !== "unknown" && Number.isFinite(incoming?.fee) && incoming.fee >= 0 && incomingRank >= previousRank) {
    return { fee: incoming.fee, feeVerification: incoming.feeVerification, feeRawText: incoming.feeRawText || null };
  }
  return prev;
}

export function detailFeeEvidence({ rawText, sourceUrl, verifiedAt }) {
  if (!isTrustedEtimadDetailsUrl(sourceUrl)) return null;
  const parsed = parseFeeEvidence(rawText);
  if (!parsed) return null;
  const at = verifiedAt instanceof Date ? verifiedAt : new Date(verifiedAt || Date.now());
  if (!Number.isFinite(at.getTime())) return null;
  return {
    value: parsed.value,
    rawText: String(rawText).trim(),
    verifiedAt: at.toISOString(),
    sourceUrl: String(sourceUrl),
  };
}

// ── DEPRECATED (P5-B0PRE — قرار د. جو 2026-08-25): ──────────────────────────
// قيمة الكراسة معلوماتية فقط ولا تؤثر على التنزيل: كل ملفات أي منافسة على
// اعتماد قابلة للتنزيل دائمًا؛ الرسوم تخص تقديم العروض (خارج نطاق المنصة).
// الدالة تُبقى كـwrapper ليتوافق الكود القديم، لكنها لا تمنع شيئًا.
export function assertDownloadFeeGate(tender) {
  void tender; // deprecated: معلوماتي فقط — لا شرط
  return true;
}
