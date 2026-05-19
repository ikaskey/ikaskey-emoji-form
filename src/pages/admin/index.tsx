import { AdminList } from '../../components/admin-list';

export default function AdminIndexPage() {
  return (
    <div className="space-y-6">
      <title>モデレーター: 申請一覧 — ブキチの絵文字工場</title>
      <h1 className="text-3xl font-bold tracking-tight">申請一覧</h1>
      <AdminList />
    </div>
  );
}

export const getConfig = async () => {
  return { render: 'dynamic' } as const;
};
