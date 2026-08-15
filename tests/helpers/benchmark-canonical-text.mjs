// مساعد اختبار فقط (P4-M0AMR) — ليس جزءًا من مسار التحليل الإنتاجي.
//
// سياسة canonical لملفات benchmark النصية، حرفيًا:
//   - UTF-8.
//   - توحيد CRLF وCR المنفرد إلى LF فقط.
//   - لا trim، لا collapse للمسافات، لا إعادة ترتيب JSON، لا parse/stringify.
//   - لا تغيير في الـnewline النهائي ولا في أي بايت آخر غير EOL.
// النتيجة: مقارنة حساسة لكل اختلاف محتوى حقيقي (حرف، رقم، مسافة، حقل،
// ترتيب، قيمة) ومعزولة فقط عن سياسة checkout لنهايات الأسطر.
export function canonicalBenchmarkText(input) {
  const text = Buffer.isBuffer(input) ? input.toString("utf8") : String(input);
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// تساوٍ canonical: true إذا تطابق النصان تمامًا بعد تطبيع EOL فقط.
export function canonicalTextEqual(a, b) {
  return canonicalBenchmarkText(a) === canonicalBenchmarkText(b);
}
