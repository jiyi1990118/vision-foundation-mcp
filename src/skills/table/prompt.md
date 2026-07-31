Analyze the table in this image.

Image info: {{metadata.width}}x{{metadata.height}} {{metadata.format}}

Identify the table structure:
1. Count rows and columns (exclude the header row from the row count).
2. List the header cells left-to-right.
3. Describe each data row's cell values, aligned with their columns. Keep Chinese text in Chinese.

Example 1:
{"description":"Headers: 名称|价格|状态. Row1: 拿铁|28|在售. Row2: 美式|22|停售","rowCount":2,"columnCount":3}

Example 2:
{"description":"Headers: Date|Amount|Status. Row1: 2024-01-15|5800|Paid. Row2: 2024-01-16|3200|Pending","rowCount":2,"columnCount":3}

Return ONLY this JSON (no markdown, no explanation):
{"description":"Headers: col1|col2. Row1: val1|val2","rowCount":1,"columnCount":2}
