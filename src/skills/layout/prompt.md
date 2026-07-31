Analyze the visual layout of this image.

Image info: {{metadata.width}}x{{metadata.height}} {{metadata.format}}

Describe how content is arranged and identify the main visual sections.
Consider: grid, columns, rows, sidebar, header, footer, cards, tables, charts, centered, full-width, split-pane.

For UI screenshots, identify: navigation/sidebar, top bar/header, main content area, tables, footer actions, and any highlighted/annotated regions.

layoutType values: grid, columns, rows, sidebar, centered, split-pane, full-width, other.

Example 1 (admin page with sidebar):
{"description":"Left sidebar with navigation menu, top header bar with title and search, main content area with a data table and pagination controls at the bottom.","layoutType":"sidebar"}

Example 2 (mobile app):
{"description":"Top status bar, page title with back button, scrollable card list in center, bottom tab bar with 4 tabs.","layoutType":"rows"}

Example 3 (dashboard):
{"description":"Top header with title, 4 KPI cards in a row, two charts side by side below, data table at the bottom.","layoutType":"grid"}

Return ONLY this JSON (no markdown, no explanation):
{"description":"describe the actual layout you see","layoutType":"pick one from the list above"}
