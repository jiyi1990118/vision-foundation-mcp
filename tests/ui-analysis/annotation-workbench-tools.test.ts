import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const appUrl = new URL('../../src/ui-analysis/annotation-workbench/static/app.js', import.meta.url);
const htmlUrl = new URL('../../src/ui-analysis/annotation-workbench/static/index.html', import.meta.url);
const cssUrl = new URL('../../src/ui-analysis/annotation-workbench/static/fixes.css', import.meta.url);

describe('workbench tool system (hand/select/draw)', () => {
  it('initialises state.tool to hand and state.draw to null', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain("tool:'hand'");
    expect(js).toContain('draw:null');
  });

  it('defines setTool, startDraw, moveDraw, endDraw functions', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('function setTool(');
    expect(js).toContain('function startDraw(');
    expect(js).toContain('function moveDraw(');
    expect(js).toContain('function endDraw(');
  });

  it('branches selectCanvasTarget on draw and hand tools', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain("if(state.tool==='draw'){startDraw(event);return}");
    expect(js).toContain("if(state.tool==='hand')");
  });

  it('routes pointermove/up through the draw gesture', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('if(state.draw&&state.draw.pointerId===e.pointerId)return moveDraw(e)');
    expect(js).toContain('if(state.draw&&state.draw.pointerId===e.pointerId)return endDraw(e)');
  });

  it('only renders resize handles in the select tool', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain("state.selectedProposal===i&&state.tool==='select'");
    expect(js).toContain("el.id===state.selectedId&&state.tool==='select'");
  });

  it('renders a draw preview rectangle while drawing', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain("state.draw)overlay.append(rectBox(state.draw.box,'drawing'");
  });

  it('creates an unknown element with a manual- id and 5px minimum', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('`manual-${crypto.randomUUID()}`');
    expect(js).toContain("type:'unknown'");
    expect(js).toContain('b.w>=5&&b.h>=5');
    expect(js).toContain("setTool('select')");
  });

  it('binds H/V/N and Escape keyboard shortcuts', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain("e.key==='Escape'&&state.tool==='draw'");
    expect(js).toMatch(/e\.key\.toLowerCase\(\)==='h'/);
    expect(js).toMatch(/e\.key\.toLowerCase\(\)==='v'\){setTool\('select'\)/);
    expect(js).toMatch(/e\.key\.toLowerCase\(\)==='n'/);
  });

  it('binds tool button click handlers', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain("$('tool-hand').onclick=()=>setTool('hand')");
    expect(js).toContain("$('tool-select').onclick=()=>setTool('select')");
    expect(js).toContain("$('tool-draw').onclick=()=>setTool('draw')");
  });

  it('syncs tool button active state and dataset in renderHeader', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('canvasWrap.dataset.tool=state.tool');
    expect(js).toContain("querySelectorAll('[data-tool-btn]')");
  });

  it('adds three tool buttons to the canvas toolbar', async () => {
    const html = await readFile(htmlUrl, 'utf8');
    expect(html).toContain('id="tool-hand"');
    expect(html).toContain('id="tool-select"');
    expect(html).toContain('id="tool-draw"');
    expect(html).toContain('data-tool-btn="hand"');
    expect(html).toContain('data-tool-btn="select"');
    expect(html).toContain('data-tool-btn="draw"');
  });

  it('styles tool cursors per data-tool attribute', async () => {
    const css = await readFile(cssUrl, 'utf8');
    expect(css).toContain('[data-tool="hand"]');
    expect(css).toContain('cursor: grab');
    expect(css).toContain('cursor: grabbing');
    expect(css).toContain('[data-tool="select"]');
    expect(css).toContain('[data-tool="draw"]');
    expect(css).toContain('cursor: crosshair');
  });

  it('styles the draw preview rectangle', async () => {
    const css = await readFile(cssUrl, 'utf8');
    expect(css).toContain('.box.drawing');
  });
});
