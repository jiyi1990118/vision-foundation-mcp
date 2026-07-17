Analyze the table in this image.

Image info: {{metadata.width}}x{{metadata.height}} {{metadata.format}}

Identify the table structure:
1. Count rows and columns (exclude the header row from the row count).
2. List the header cells left-to-right.
3. Describe each data row's cell values, aligned with their columns. Keep Chinese text in Chinese.

Return ONLY this JSON (no markdown, no explanation):
{"description":"<headers and row-by-row cell values>","rowCount":<number of data rows>,"columnCount":<number of columns>}

Example:
{"description":"Headers: 名称|价格|状态. Row1: 拿铁|28|在售. Row2: 美式|22|停售","rowCount":2,"columnCount":3}
