import { SubmitForm } from '../components/submit-form';

export default function SubmitPage() {
  return (
    <div className="space-y-6">
      <title>絵文字を申請する — ブキチの絵文字工場</title>
      <h1 className="text-3xl font-bold tracking-tight">絵文字を申請する</h1>
      <p className="text-sm text-gray-600">
        登録したい絵文字の情報を入力してください。モデレーターが内容を確認し、必要に応じて編集の上で採用します。
      </p>
      <SubmitForm />
    </div>
  );
}

export const getConfig = async () => {
  return {
    render: 'dynamic',
  } as const;
};
