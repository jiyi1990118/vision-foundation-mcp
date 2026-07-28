import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const appPath = new URL('../../src/ui-analysis/annotation-workbench/static/app.js', import.meta.url);

describe('annotation workbench component type selects', () => {
  it('groups component type options by annotation role', async () => {
    const source = await readFile(appPath, 'utf8');

    expect(source).toContain("{label:'页面结构',types:['page','header','footer','navbar','sidebar','toolbar']}");
    expect(source).toContain("{label:'布局与容器',types:['container','section','card','list','listItem','table','row','column','grid']}");
    expect(source).toContain("{label:'表单与操作',types:['button','iconButton','input','textarea','select','checkbox','radio','switch']}");
    expect(source).toContain("document.createElement('optgroup')");
  });
});
