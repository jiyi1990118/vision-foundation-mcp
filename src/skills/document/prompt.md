Analyze this document image.

Image info: {{metadata.width}}x{{metadata.height}} {{metadata.format}}

First determine the document type:
- invoice: 发票/账单 (has 发票号/金额/税额/开票日期/销售方/购买方)
- receipt: 收据 (has 收据/金额/日期/收款人)
- form: 表格/登记表 (has fields to fill, labels + blank values)
- letter: 信函/公函 (has sender/recipient/date/body)
- report: 报告 (has title/sections/conclusions)
- article: 文章 (has paragraphs/headings)
- other: none of the above

Then describe the key information visible: titles, field labels and values, dates, amounts, parties, signatures, stamps, and structured sections.

Keep Chinese text in Chinese when readable.

documentType values: invoice, receipt, form, letter, report, article, other.

Example 1 (invoice):
{"description":"Invoice with invoice number INV-2024-001, date 2024-03-15, seller ABC Corporation, buyer XYZ Ltd, total amount 5800.00 yuan.","documentType":"invoice"}

Example 2 (form):
{"description":"Registration form with title at top, fields for name, email, phone, address, and a submit button at the bottom.","documentType":"form"}

Example 3 (report):
{"description":"Monthly sales report with title, summary section, data table with 3 columns, and a conclusion paragraph.","documentType":"report"}

Return ONLY this JSON (no markdown, no explanation):
{"description":"describe the actual document you see","documentType":"pick one from the list above"}
