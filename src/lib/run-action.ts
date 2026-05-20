/**
 * モデレーター画面の非同期アクション (採用 / 却下 / 保存 / 削除) を、
 * 「busy 状態の確実な解除」と「未捕捉例外の捕捉」付きで実行するヘルパー。
 *
 * 背景: 各アクションは `fetch` → `r.json()` の素朴な実装で、try/catch が無かった。
 * そのため fetch がネットワークエラーで reject したり、レスポンスが非 JSON だと
 * `await r.json()` が throw し、busy フラグを `null` に戻す処理まで到達しない。
 * 結果として画面上の全ボタンが `disabled` のまま固まり「ボタンが押せない」状態に
 * 陥っていた (リロードでしか復帰しない)。
 *
 * このヘルパーは `finally` で必ず busy を解除し、捕捉した例外をエラーメッセージへ
 * 変換して通知することで、通信が失敗しても UI が固まらないことを保証する。
 */
export type RunActionParams<K extends string> = {
  /** 実行中を示すキー (例: `'approve'`)。開始時にセットされ、終了時に必ず `null` へ戻る。 */
  kind: K;
  /** busy 状態を更新するセッター (React の `setState` を想定)。 */
  setBusy: (kind: K | null) => void;
  /** 未捕捉例外が発生した際に、ユーザー提示用メッセージを通知するコールバック。 */
  onError: (message: string) => void;
  /**
   * 実処理。内部で成功 / 業務エラーのメッセージは自由に設定してよい。
   * ここから throw された例外のみ {@link RunActionParams.onError} に渡る。
   */
  action: () => Promise<void>;
};

/**
 * {@link RunActionParams.action} を busy 管理 + 例外捕捉付きで実行する。
 *
 * - 開始時に `setBusy(kind)`、終了時 (成功・失敗いずれも) に `setBusy(null)` を呼ぶ。
 * - `action` が throw した場合は {@link toErrorMessage} で文字列化して `onError` に渡す。
 *   `action` が正常終了した場合 `onError` は呼ばれない。
 *
 * @returns action の解決後 (例外は内部で握り潰す) に解決する Promise。
 */
export async function runAction<K extends string>(params: RunActionParams<K>): Promise<void> {
  const { kind, setBusy, onError, action } = params;
  setBusy(kind);
  try {
    await action();
  } catch (err) {
    onError(toErrorMessage(err));
  } finally {
    setBusy(null);
  }
}

/**
 * 任意の throw 値を人間可読な文字列へ変換する。
 *
 * `Error` ならその `message`、それ以外は `String()` 表現を返す。
 */
export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
