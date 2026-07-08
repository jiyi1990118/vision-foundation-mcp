Classify this image into exactly ONE category.

Image info: {{metadata.width}}x{{metadata.height}} {{metadata.format}} complexity={{metadata.complexity}}

CRITICAL: Determine the MEDIUM first, then the subject:
1. Is it a REAL photograph or screen capture? → Consider photo/screenshot
2. Is it DRAWN/AI-GENERATED/RENDERED artwork? → Consider illustration
3. Then classify the subject within that medium.

Categories and meanings:
- dashboard: data dashboard with KPI cards, metrics, multiple info panels
- chart: a single data chart (bar/line/pie), no surrounding UI
- diagram: flowchart, architecture diagram, mind map, relationship graph
- document: scanned or photographed text document, invoice, receipt, letter
- poster: designed poster, event flyer, advertisement with text + graphics
- ui: app or web interface with controls/widgets/buttons
- screenshot: a REAL screen capture from actual software/desktop (NOT artistic depictions)
- photo: a real-world photograph of people, objects, scenes, or nature
- illustration: drawn/painted/rendered/AI-generated artwork, anime, game art, concept art — NOT a real photo
- logo: a brand logo or simple mark
- icon: a single small icon or emoji-style graphic
- map: a geographic map or floor plan
- comic: comic strip, manga panel, sequential art
- meme: image with overlaid meme text
- other: none of the above

Rules:
- Do NOT default to "document" for images that are not primarily text.
- A photo of people → "photo". A drawn artwork or render → "illustration". A UI screen → "ui".
- If the image shows a designed visual (art, render, drawing), choose "illustration", NOT "document".

Boundary cases (choose carefully):
- REAL screen capture showing code editor/terminal → "screenshot", NOT "photo"
- REAL terminal/console window capture → "screenshot", NOT "document"
- Flowchart with boxes and arrows → "diagram", NOT "illustration" (even if colorful)
- Architecture diagram (system design) → "diagram", NOT "document"
- App interface mockup/design → "ui" (if showing controls/buttons), NOT "screenshot"
- Screen capture of running app → "screenshot" (if showing actual usage), NOT "ui"
- Anime/drawn/AI-generated character in ANY scene → ALWAYS "illustration" (regardless of content shown)
- REAL photo of person working (screen visible in background) → "photo", NOT "screenshot"
- Invoice or receipt scan → "document", NOT "screenshot"

Output ONLY this JSON (no markdown, no explanation, no extra text):
{"category": "<one from list>", "confidence": <0.0-1.0>}