# مصدر خط المنصة وترخيصه

- **الخط الأصلي:** DejaVu Sans (نسخة مضمّنة مع matplotlib المحلية، بلا أي تنزيل شبكي).
- **الترخيص:** DejaVu Fonts License (مشتقة من Bitstream Vera License) — تسمح بإعادة
  التوزيع والتضمين والتعديل بشرط إرفاق نص الترخيص وعدم استعمال أسماء Bitstream/DejaVu
  لتسويق مشتقات دون إذن. النص الكامل في `LICENSE-DEJAVU.txt`.
- **الملف:** `dejavu-sans-arabic-subset.ttf` — subset حتمي (fontTools 4.62.1، محلي)
  يقتصر على: ASCII القابل للطباعة، كتلة العربية U+0600–U+06FF، أشكال العرض العربية
  U+FE70–U+FEF4، والشرطة الطويلة U+2014.
- **أمر التوليد (توثيقي، نُفذ محليًا مرة واحدة):**

  ```bash
  python -m fontTools.subset DejaVuSans.ttf \
    --unicodes=U+0020-007E,U+0600-06FF,U+FE70-FEF4,U+2014 \
    --no-hinting --desubroutinize --notdef-outline \
    --output-file=benchmark/assets/fonts/dejavu-sans-arabic-subset.ttf
  ```

- أُسقطت جدول FFTM (طابع زمني داخلي) من الـsubset — لا توجد أي metadata زمنية
  تُستخدم في ملفات PDF الناتجة.
- الخط جزء من الحزمة المنقولة؛ لا اعتماد على أي مسار نظام في أي جهاز.
