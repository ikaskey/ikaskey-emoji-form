'use client';

import { useEffect, useState } from 'react';
import * as mfm from 'mfm-js';
import type { MfmNode } from 'mfm-js';

type EmojiMap = Record<string, string>;

type CachedEmojiMap = { map: EmojiMap; fetchedAt: number };

let cachedMapPromise: Promise<EmojiMap> | null = null;
function loadEmojiMap(): Promise<EmojiMap> {
  if (!cachedMapPromise) {
    cachedMapPromise = fetch('/api/emoji-map')
      .then((r) => (r.ok ? (r.json() as Promise<CachedEmojiMap>) : Promise.reject(r.status)))
      .then((d) => d.map)
      .catch(() => ({}));
  }
  return cachedMapPromise;
}

type Props = {
  text: string;
  /** display: inline / block (デフォルト inline) */
  inline?: boolean;
  /** プレーンテキスト fallback (parse 不能時) */
  plain?: boolean;
};

/**
 * Misskey MFM (Markup For Misskey) を React で描画する最小限のレンダラー。
 * 対応ノード: text / bold / italic / strike / small / center / quote / link / mention
 *           / hashtag / url / emojiCode / unicodeEmoji / inlineCode / blockCode
 *           / mathInline / mathBlock / search / plain / fn (一部の x2/x3/x4,jelly,bounce 等)
 * 未知ノードは plain text にフォールバックする。
 */
export function Mfm({ text, inline = true, plain = false }: Props) {
  const [emojis, setEmojis] = useState<EmojiMap>({});

  useEffect(() => {
    loadEmojiMap().then(setEmojis);
  }, []);

  if (!text) return null;
  if (plain) return <>{text}</>;

  let nodes: MfmNode[];
  try {
    nodes = inline ? mfm.parseSimple(text) : mfm.parse(text);
  } catch {
    return <>{text}</>;
  }

  const Wrapper = inline ? 'span' : 'div';
  return (
    <Wrapper className="mfm">
      {nodes.map((n, i) => (
        <Node key={i} node={n} emojis={emojis} />
      ))}
    </Wrapper>
  );
}

function Node({ node, emojis }: { node: MfmNode; emojis: EmojiMap }) {
  switch (node.type) {
    case 'text':
      return <>{node.props.text}</>;

    case 'bold':
      return (
        <strong>
          <Children nodes={node.children} emojis={emojis} />
        </strong>
      );

    case 'italic':
      return (
        <em>
          <Children nodes={node.children} emojis={emojis} />
        </em>
      );

    case 'strike':
      return (
        <del>
          <Children nodes={node.children} emojis={emojis} />
        </del>
      );

    case 'small':
      return (
        <small style={{ opacity: 0.7 }}>
          <Children nodes={node.children} emojis={emojis} />
        </small>
      );

    case 'center':
      return (
        <div style={{ textAlign: 'center' }}>
          <Children nodes={node.children} emojis={emojis} />
        </div>
      );

    case 'quote':
      return (
        <blockquote
          style={{
            borderLeft: '3px solid #888',
            margin: '0.25em 0',
            paddingLeft: '0.75em',
            color: '#555',
          }}
        >
          <Children nodes={node.children} emojis={emojis} />
        </blockquote>
      );

    case 'plain':
      return (
        <span>
          <Children nodes={node.children} emojis={emojis} />
        </span>
      );

    case 'link': {
      return (
        <a href={node.props.url} target="_blank" rel="noreferrer" className="text-blue-600 underline">
          <Children nodes={node.children} emojis={emojis} />
        </a>
      );
    }

    case 'url':
      return (
        <a href={node.props.url} target="_blank" rel="noreferrer" className="text-blue-600 underline">
          {node.props.url}
        </a>
      );

    case 'mention':
      return (
        <span className="text-blue-600">
          @{node.props.username}
          {node.props.host ? `@${node.props.host}` : ''}
        </span>
      );

    case 'hashtag':
      return <span className="text-purple-600">#{node.props.hashtag}</span>;

    case 'emojiCode': {
      const name = node.props.name;
      const url = emojis[name];
      if (url) {
        return (
          <img
            src={url}
            alt={`:${name}:`}
            title={`:${name}:`}
            referrerPolicy="no-referrer"
            style={{
              display: 'inline-block',
              height: '1.4em',
              verticalAlign: 'middle',
              margin: '0 0.1em',
            }}
          />
        );
      }
      return <span style={{ opacity: 0.6 }}>:{name}:</span>;
    }

    case 'unicodeEmoji':
      return <>{node.props.emoji}</>;

    case 'inlineCode':
      return (
        <code className="rounded bg-gray-100 px-1 font-mono text-sm">
          {node.props.code}
        </code>
      );

    case 'blockCode':
      return (
        <pre className="overflow-x-auto rounded bg-gray-100 p-2 text-sm">
          <code>{node.props.code}</code>
        </pre>
      );

    case 'mathInline':
      return <code className="font-mono">{node.props.formula}</code>;

    case 'mathBlock':
      return <pre className="font-mono">{node.props.formula}</pre>;

    case 'search':
      return (
        <a
          href={`https://www.google.com/search?q=${encodeURIComponent(node.props.query)}`}
          target="_blank"
          rel="noreferrer"
          className="text-blue-600 underline"
        >
          {node.props.query} (検索)
        </a>
      );

    case 'fn': {
      const fname = node.props.name;
      // 簡易対応: x2/x3/x4 倍率、jelly/bounce/spin はアニメ無しで縮小 / 装飾だけ
      const style: React.CSSProperties = {};
      if (fname === 'x2') style.fontSize = '200%';
      if (fname === 'x3') style.fontSize = '400%';
      if (fname === 'x4') style.fontSize = '600%';
      if (fname === 'tada') style.fontSize = '200%';
      if (fname === 'rainbow') {
        style.background = 'linear-gradient(to right, red, orange, yellow, green, blue, indigo, violet)';
        style.WebkitBackgroundClip = 'text';
        style.color = 'transparent';
      }
      return (
        <span style={style}>
          <Children nodes={node.children} emojis={emojis} />
        </span>
      );
    }

    default:
      // 未対応: そのまま children を表示 (なければ何も出さない)
      // @ts-expect-error: node may not have children
      if (node.children) {
        // @ts-expect-error
        return <Children nodes={node.children} emojis={emojis} />;
      }
      return null;
  }
}

function Children({ nodes, emojis }: { nodes: MfmNode[]; emojis: EmojiMap }) {
  return (
    <>
      {nodes.map((n, i) => (
        <Node key={i} node={n} emojis={emojis} />
      ))}
    </>
  );
}
