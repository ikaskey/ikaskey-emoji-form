import { describe, it, expect } from 'vitest';
import { safeReturnTo } from './miauth';

const O = 'https://emoji.example';

describe('safeReturnTo', () => {
  it('同じオリジンのパスはクエリ込みで返す', () => {
    expect(safeReturnTo('/admin/12', O)).toBe('/admin/12');
    expect(safeReturnTo('/admin?status=rejected', O)).toBe('/admin?status=rejected');
    expect(safeReturnTo(`${O}/my`, O)).toBe('/my'); // Referer は絶対 URL で来る
  });

  it('外部サイトへの戻り先は / にする', () => {
    expect(safeReturnTo('https://evil.example/', O)).toBe('/');
    expect(safeReturnTo('//evil.example/x', O)).toBe('/');
    expect(safeReturnTo('/\\evil.example', O)).toBe('/');
    expect(safeReturnTo('javascript:alert(1)', O)).toBe('/');
  });

  it('認証まわりのパスと空値は / にする', () => {
    expect(safeReturnTo('/login', O)).toBe('/');
    expect(safeReturnTo('/logout', O)).toBe('/');
    expect(safeReturnTo('/auth/callback?session=x', O)).toBe('/');
    expect(safeReturnTo(undefined, O)).toBe('/');
    expect(safeReturnTo('', O)).toBe('/');
  });
});
