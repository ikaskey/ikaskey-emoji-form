import '../styles.css';

import type { ReactNode } from 'react';
import { Footer } from '../components/footer';
import { Header } from '../components/header';

type RootLayoutProps = { children: ReactNode };

export default async function RootLayout({ children }: RootLayoutProps) {
  const data = await getData();

  return (
    <div className="min-h-svh flex flex-col">
      <meta name="description" content={data.description} />
      <meta name="theme-color" content="#563d00" />
      <link rel="icon" type="image/png" href={data.icon} />
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Reggae+One&family=Zen+Kaku+Gothic+New:wght@400;500;700;900&family=JetBrains+Mono:wght@400;600&display=swap"
        precedence="font"
      />
      <Header />
      <main className="flex-1 w-full mx-auto max-w-3xl px-4 sm:px-6 py-10 sm:py-14">
        {children}
      </main>
      <Footer />
    </div>
  );
}

const getData = async () => {
  const data = {
    description: 'いかすきー (ikaskey.bktsk.com) のカスタム絵文字申請窓口。',
    icon: '/images/favicon.png',
  };

  return data;
};

export const getConfig = async () => {
  // dynamic にしないと子ページ (render: 'dynamic') の SSR 応答に
  // layout の CSS link が inject されない (Waku 1.0.0-beta の挙動)
  return {
    render: 'dynamic',
  } as const;
};
