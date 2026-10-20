/**
 * 今いるページに戻ってくるログインリンクの URL。
 * (サーバー側でも Referer から戻り先を推測するが、ブラウザ設定で送られないこともあるため明示する)
 */
export function loginHref(): string {
  if (typeof window === 'undefined') return '/login';
  const here = `${window.location.pathname}${window.location.search}`;
  return `/login?returnTo=${encodeURIComponent(here)}`;
}
