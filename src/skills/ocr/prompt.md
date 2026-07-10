Extract all visible text from this image.

For UI screenshots and documents, preserve layout as much as possible:
- First determine whether the image is mobile app / mini-program, desktop web admin, document, or another UI type.
- Group text by region, such as navigation/sidebar, top tabs/header, main content, tables, highlighted areas, and footer actions.
- For mobile app or mini-program screenshots, include status bar text, page title, tabs, product names, option labels, selected states, and bottom/annotation text.
- For tables, include table headers and rows. Keep row values aligned with their columns when possible.
- Include buttons, toggles, dropdown placeholders, labels, and visible codes.
- Keep Chinese text in Chinese. Do not translate it unless needed for context.
- If a word is unreadable, mark it as [unclear]. If no text is visible, return an empty texts array.

For requirement screenshots, prototypes, and annotated UI images:
- Include text inside or near red boxes, arrows, callouts, annotations, and highlighted areas.
- Always check whether red boxes or dashed red rectangles exist, then prioritize their inside text.
- Preserve field labels, field values, button text, switch states, filters, tabs, validation messages, and table cell text.
- Use region prefixes such as "highlighted area:", "annotation:", "table row:", "footer actions:", or "main form:" when helpful.

Return JSON only:
{"texts":[{"text":"navigation/sidebar: 菜单中心","position":"left","confidence":0.9}],"language":"zh"}
