import { describe, it, expect, vi } from 'vitest';
import { runAction, toErrorMessage } from './run-action';

describe('runAction', () => {
  it('成功時: 開始で busy をセットし、終了で必ず null へ戻す', async () => {
    const setBusy = vi.fn();
    const onError = vi.fn();

    await runAction({
      kind: 'approve',
      setBusy,
      onError,
      action: async () => {
        // 実行中は kind がセットされていること
        expect(setBusy).toHaveBeenLastCalledWith('approve');
      },
    });

    expect(setBusy).toHaveBeenNthCalledWith(1, 'approve');
    expect(setBusy).toHaveBeenLastCalledWith(null);
    expect(setBusy).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it('action が throw しても busy を null へ戻す (ボタンが固まらない)', async () => {
    const setBusy = vi.fn();
    const onError = vi.fn();

    await runAction({
      kind: 'save',
      setBusy,
      onError,
      action: async () => {
        throw new Error('ネットワークエラー');
      },
    });

    // ここが本来のバグの再発防止: 例外発生でも busy は解除される
    expect(setBusy).toHaveBeenLastCalledWith(null);
    expect(setBusy).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledExactlyOnceWith('ネットワークエラー');
  });

  it('action が非 Error を throw しても文字列化して onError に渡す', async () => {
    const setBusy = vi.fn();
    const onError = vi.fn();

    await runAction({
      kind: 'reject',
      setBusy,
      onError,
      // 例: r.json() が予期せぬ値で reject するケース
      action: async () => {
        throw 'unexpected token < in JSON';
      },
    });

    expect(onError).toHaveBeenCalledExactlyOnceWith('unexpected token < in JSON');
    expect(setBusy).toHaveBeenLastCalledWith(null);
  });

  it('runAction 自体は reject しない (例外を内部で握り潰す)', async () => {
    const setBusy = vi.fn();
    const onError = vi.fn();

    await expect(
      runAction({
        kind: 'delete',
        setBusy,
        onError,
        action: async () => {
          throw new Error('boom');
        },
      }),
    ).resolves.toBeUndefined();
  });
});

describe('toErrorMessage', () => {
  it('Error は message を返す', () => {
    expect(toErrorMessage(new Error('失敗しました'))).toBe('失敗しました');
  });

  it('Error 以外は String() 表現を返す', () => {
    expect(toErrorMessage('文字列エラー')).toBe('文字列エラー');
    expect(toErrorMessage(42)).toBe('42');
    expect(toErrorMessage(null)).toBe('null');
    expect(toErrorMessage(undefined)).toBe('undefined');
  });
});
