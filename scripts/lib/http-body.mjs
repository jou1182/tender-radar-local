// قراءة جسم JSON محدودة الحجم — P4-A0R.
// أي جسم يتجاوز 64 ك.ب يرفض فورًا أثناء القراءة قبل أي تحليل JSON،
// في كل نقاط الخدمة المحلية دون استثناء.
export const defaultMaxJsonBodyBytes = 64 * 1024;

export async function readJsonBodyLimited(request, maxBytes = defaultMaxJsonBodyBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error(`حجم جسم الطلب يتجاوز الحد المسموح (${Math.round(maxBytes / 1024)} ك.ب).`);
      error.code = "REQUEST_BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
