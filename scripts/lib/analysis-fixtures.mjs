// سجل fixtures التحليل المعروفة — P4-A0.
// القائمة مغلقة وثابتة: لا يقبل محرك التحليل إلا fixtureId من هذه القائمة،
// ولا يقبل أي مسار ملف يرسله العميل إطلاقًا. جميع الملفات مصطنعة وغير حساسة.
export const analysisFixtureRootName = "analysis-fixtures";

export const analysisFixtures = [
  {
    fixtureId: "fixture-booklet-pdf",
    fileName: "booklet-sample.pdf",
    documentType: "pdf",
    tenderReference: "260000009999",
    title: "كراسة شروط مصطنعة (PDF) — 3 صفحات",
  },
  {
    fixtureId: "fixture-boq-xlsx",
    fileName: "boq-sample.xlsx",
    documentType: "xlsx",
    tenderReference: "260000009999",
    title: "جدول كميات مصطنع (XLSX) — ورقتان",
  },
  {
    fixtureId: "fixture-conditions-docx",
    fileName: "conditions-sample.docx",
    documentType: "docx",
    tenderReference: "260000009999",
    title: "شروط عامة مصطنعة (DOCX) — أقسام وجدول",
  },
];

export function findAnalysisFixture(fixtureId) {
  return analysisFixtures.find((fixture) => fixture.fixtureId === fixtureId) || null;
}
