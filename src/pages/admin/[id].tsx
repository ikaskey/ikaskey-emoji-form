import { AdminDetail } from '../../components/admin-detail';

type Props = {
  id: string;
};

export default function AdminDetailPage({ id }: Props) {
  const n = parseInt(id, 10);
  if (!Number.isFinite(n) || n <= 0) {
    return (
      <div className="text-sm text-red-700">不正な申請 ID: {id}</div>
    );
  }
  return (
    <div className="space-y-6">
      <title>申請 #{n} — ブキチの絵文字工場</title>
      <h1 className="text-2xl font-bold tracking-tight">申請 #{n}</h1>
      <AdminDetail id={n} />
    </div>
  );
}

export const getConfig = async () => {
  return { render: 'dynamic' } as const;
};
