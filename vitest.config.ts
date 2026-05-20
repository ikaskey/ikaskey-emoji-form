import { defineConfig } from 'vitest/config';

// 単体テストは DOM 非依存のロジック (src/lib 配下) のみを対象とするため、
// 既定の node 環境で十分。Waku/Cloudflare のビルド設定とは独立させる。
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
