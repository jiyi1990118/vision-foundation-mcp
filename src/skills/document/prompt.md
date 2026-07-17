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

Return ONLY this JSON (no markdown, no explanation):
{"description":"<key information and structure of the document>","documentType":"<invoice|receipt|form|letter|report|article|other>"}
