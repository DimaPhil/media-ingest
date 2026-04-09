import { describe, expect, it } from 'vitest';

import {
  parseGoogleDriveFileId,
  parseTelegramUri,
  validateHttpSourceUri,
  validateYoutubeSourceUri,
  validateYtDlpSourceUri,
} from '../src/source-validation';

describe('source validation', () => {
  it('accepts supported YouTube watch URLs', () => {
    expect(
      validateYoutubeSourceUri('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    ).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('rejects unsupported YouTube hosts', () => {
    expect(() => validateYoutubeSourceUri('https://example.com/watch?v=dQw4w9WgXcQ')).toThrow(
      'Unsupported YouTube URL',
    );
  });

  it('accepts supported YouTube short links', () => {
    expect(validateYoutubeSourceUri('https://youtu.be/dQw4w9WgXcQ')).toBe(
      'https://youtu.be/dQw4w9WgXcQ',
    );
  });

  it('accepts supported YouTube shorts links', () => {
    expect(validateYoutubeSourceUri('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    );
  });

  it('rejects YouTube playlists', () => {
    expect(
      () => validateYoutubeSourceUri('https://www.youtube.com/playlist?list=PL1234567890'),
    ).toThrow('YouTube playlists are not supported in v1');
  });

  it('rejects empty YouTube short links', () => {
    expect(() => validateYoutubeSourceUri('https://youtu.be/')).toThrow(
      'YouTube short links must include a video id',
    );
  });

  it('extracts Google Drive file ids from file URLs', () => {
    expect(
      parseGoogleDriveFileId('https://drive.google.com/file/d/abc123/view?usp=sharing'),
    ).toBe('abc123');
  });

  it('extracts Google Drive file ids from query params', () => {
    expect(
      parseGoogleDriveFileId('https://drive.google.com/uc?id=abc123&export=download'),
    ).toBe('abc123');
  });

  it('rejects Google Drive folder URLs', () => {
    expect(
      () => parseGoogleDriveFileId('https://drive.google.com/drive/folders/abc123'),
    ).toThrow('Google Drive folders are not supported in v1');
  });

  it('rejects unsupported Google Drive hosts', () => {
    expect(() => parseGoogleDriveFileId('https://example.com/file/d/abc123/view')).toThrow(
      'Unsupported Google Drive URL',
    );
  });

  it('parses public Telegram post links', () => {
    expect(parseTelegramUri('https://t.me/chipdachat/60798')).toEqual({
      chatRef: '@chipdachat',
      messageId: 60798,
    });
  });

  it('parses private Telegram post links', () => {
    expect(parseTelegramUri('https://t.me/c/123456789/42')).toEqual({
      chatRef: '-100123456789',
      messageId: 42,
    });
  });

  it('rejects invalid Telegram message ids', () => {
    expect(() => parseTelegramUri('https://t.me/chipdachat/not-a-number')).toThrow(
      'Telegram message id must be a positive integer',
    );
  });

  it('rejects unsupported Telegram hosts', () => {
    expect(() => parseTelegramUri('https://example.com/chipdachat/60798')).toThrow(
      'Unsupported Telegram post URL',
    );
  });

  it('accepts generic http sources', () => {
    expect(validateHttpSourceUri('https://example.com/video.mp4')).toBe(
      'https://example.com/video.mp4',
    );
  });

  it('rejects invalid generic source URIs', () => {
    expect(() => validateHttpSourceUri('not-a-url')).toThrow(
      'Source URI must be a valid absolute URL',
    );
  });

  it('rejects non-http generic source URIs', () => {
    expect(() => validateHttpSourceUri('ftp://example.com/video.mp4')).toThrow(
      'Source URI must use http or https',
    );
  });

  it('accepts generic yt-dlp URLs', () => {
    expect(validateYtDlpSourceUri('https://vimeo.com/148751763')).toBe(
      'https://vimeo.com/148751763',
    );
  });
});
