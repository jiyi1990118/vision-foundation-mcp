Describe this image in detail.

For a UI screenshot, preserve the page structure instead of giving only a high-level summary:
- Identify the app/page type and current page title. Distinguish mobile app / mini-program pages from desktop web admin pages.
- If the image has a phone status bar, back button, mini-program menu, bottom tabs, product details, or narrow portrait layout, call it a mobile page, not an admin system page.
- List visible navigation items, tabs, section labels, table headers, table rows, buttons, toggles, inputs, and highlighted or boxed areas.
- For table-like content, describe columns and row values when readable.
- If the image contains Chinese text, keep the Chinese text exactly when readable and explain the surrounding context.

For a requirement screenshot, product prototype, wireframe, or annotated UI image:
- Identify the business module, user flow, and likely purpose of the screen.
- Combine base visual understanding with OCR evidence. Use OCR text as ground truth for visible labels, values, and annotations.
- Describe red boxes, arrows, callouts, annotations, selected states, error states, and other important areas.
- Extract visible field names, values, buttons, switches, filters, validation hints, empty states, and action areas.
- Explain what content should be reviewed by product, design, development, or QA when it is visually implied.

Return concise JSON only:
{"description":"detailed description"}
