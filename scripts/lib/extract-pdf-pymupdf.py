# P5-PYMUPDF: مستخرج نص PDF بديل ثالث (بعد pdf.js وpoppler) عبر PyMuPDF.
# يُستدعى من Node فقط (extractPdfViaPymupdf في analysis-documents.mjs) بوسيط
# وحيد: مسار ملف مؤقت ولّده Node ذاتيًا من buffer في الذاكرة — لا مسار من
# مستدعٍ خارجي إطلاقًا ولا أي وصول شبكي. يطبع JSON خالصًا على stdout فقط؛ أي
# تحذير أو خطأ يذهب إلى stderr حتى لا يلوّث الناتج المتوقَع في Node.
#
# لماذا PyMuPDF: بعض خطوط Type0 المدمجة في كراسات اعتماد المصدَّرة من أنظمة
# معينة تُسقط الأحرف العربية بصمت عبر pdf.js وpoppler معًا (تختفي دون أثر
# بينما تبقى الأرقام والترقيم اللاتيني سليمة) — MuPDF يحلّ جدول ترميز هذه
# الخطوط بشكل مختلف وينتج نصًا عربيًا سليمًا **بترتيب منطقي صحيح مسبقًا**
# (بخلاف poppler الذي يحتاج عكس ترتيب الكلمات يدويًا بعده) — لذلك لا يُطبَّق
# أي إصلاح RTL على مخرجات هذا المسار في Node.
import json
import sys


def main():
    if len(sys.argv) != 2:
        print("usage: extract-pdf-pymupdf.py <pdf-path>", file=sys.stderr)
        return 2
    pdf_path = sys.argv[1]

    try:
        import pymupdf
    except ImportError as error:
        print(f"pymupdf غير مثبت: {error}", file=sys.stderr)
        return 3

    try:
        document = pymupdf.open(pdf_path)
    except Exception as error:  # noqa: BLE001 — أي عطل فتح يُبلَّغ لا يُبتلَع
        print(f"تعذر فتح PDF عبر pymupdf: {error}", file=sys.stderr)
        return 4

    pages = []
    try:
        for page in document:
            text = page.get_text("text") or ""
            lines = [line.strip() for line in text.split("\n")]
            pages.append([line for line in lines if line])
    finally:
        document.close()

    sys.stdout.reconfigure(encoding="utf-8")
    json.dump({"pages": pages}, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
