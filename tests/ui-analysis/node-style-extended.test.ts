import { describe, it, expect } from 'vitest';
import type { NodeStyle } from '../../src/ui-analysis/ir/types.js';

describe('Extended NodeStyle', () => {
  it('supports gradient field', () => {
    const style: NodeStyle = {
      backgroundColor: '#1677ff',
      gradient: { type: 'linear', direction: 'to bottom', stops: [{ offset: 0, color: '#1677ff' }, { offset: 1, color: '#7d3fd2' }] },
    };
    expect(style.gradient).toBeDefined();
    expect(style.gradient!.type).toBe('linear');
    expect(style.gradient!.stops).toHaveLength(2);
  });

  it('supports border width and style', () => {
    const style: NodeStyle = {
      backgroundColor: '#fff',
      borderColor: '#d9d9d9',
      borderWidth: 1,
      borderStyle: 'solid',
    };
    expect(style.borderWidth).toBe(1);
    expect(style.borderStyle).toBe('solid');
  });

  it('supports padding', () => {
    const style: NodeStyle = {
      backgroundColor: '#fff',
      padding: { top: 12, right: 16, bottom: 12, left: 16 },
    };
    expect(style.padding).toBeDefined();
    expect(style.padding!.left).toBe(16);
  });

  it('supports typography fields', () => {
    const style: NodeStyle = {
      backgroundColor: '#fff',
      textColor: '#333',
      fontSize: 14,
      fontWeight: 400,
      lineHeight: 1.5,
      letterSpacing: 0.5,
      textAlign: 'center',
      textDecoration: 'none',
    };
    expect(style.lineHeight).toBe(1.5);
    expect(style.letterSpacing).toBe(0.5);
    expect(style.textAlign).toBe('center');
    expect(style.textDecoration).toBe('none');
  });

  it('supports opacity', () => {
    const style: NodeStyle = {
      backgroundColor: '#fff',
      opacity: 0.8,
    };
    expect(style.opacity).toBe(0.8);
  });
});
