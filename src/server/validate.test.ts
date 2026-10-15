import { describe, it, expect } from 'vitest';
import { sniffImageMime, imageContentMatches } from './validate';

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));

describe('sniffImageMime', () => {
  it('各形式の先頭バイトを判定する', () => {
    expect(sniffImageMime(bytes([0x89], 'PNG\r\n\x1a\n', [0, 0]))).toBe('image/png');
    expect(sniffImageMime(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageMime(bytes('GIF89a', [1, 0]))).toBe('image/gif');
    expect(sniffImageMime(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageMime(bytes([0, 0, 0, 0x1c], 'ftypavif'))).toBe('image/avif');
  });

  it('画像でない・短すぎる中身は null', () => {
    expect(sniffImageMime(bytes('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull();
    expect(sniffImageMime(bytes('<html>'))).toBeNull();
    expect(sniffImageMime(new Uint8Array())).toBeNull();
    expect(sniffImageMime(bytes([0x89], 'PN'))).toBeNull();
  });
});

describe('imageContentMatches', () => {
  const png = bytes([0x89], 'PNG\r\n\x1a\n');
  it('APNG の申告は PNG の中身と一致とみなす', () => {
    expect(imageContentMatches('image/apng', png)).toBe(true);
    expect(imageContentMatches('image/png', png)).toBe(true);
  });
  it('申告と中身が違えば不一致', () => {
    expect(imageContentMatches('image/gif', png)).toBe(false);
    expect(imageContentMatches('image/png', bytes('<html>'))).toBe(false);
  });
});
