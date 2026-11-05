import type { CSSProperties, ReactNode } from 'react';
import { cx } from '../ui';
import { useImageSrc, type ImageVariant } from './client';
import { generated, type ImageMeta } from './model';
import './images.css';

/** What an image's tooltip says: its metadata (no captions on screen, VISUAL §1). */
export function describe(m: ImageMeta): string {
  const o = m.origin;
  const made =
    o.by === 'openai'
      ? `${o.model} · ${o.quality} · ${o.size}`
      : o.by === 'fake'
        ? `fake · ${o.size}`
        : o.by === 'sheet'
          ? `cell ${o.cell + 1} of an icon sheet`
          : `${o.preset} filter`;
  const cost = m.costUsd !== undefined && m.costUsd > 0 ? ` · $${m.costUsd.toFixed(3)}` : '';
  return `${m.kind === 'icon' ? 'Icon' : 'Concept'} · ${made}${cost} · ${m.created.slice(0, 10)}`;
}

/**
 * One image: a concept covers its box; an icon is always pixelated, never
 * smoothed. A generated image carries the AI's colour as a hairline only.
 * Until its pixels arrive it is a quiet shimmer.
 */
export function Thumb({
  meta,
  size,
  variant,
  className,
  style,
  title,
  testId,
}: {
  meta: ImageMeta;
  /** Square side in px; omit to fill the parent. */
  size?: number;
  /** Default: the 256px thumb for concepts, the image itself for icons. */
  variant?: ImageVariant;
  className?: string;
  style?: CSSProperties;
  title?: string;
  testId?: string;
}): ReactNode {
  const src = useImageSrc(meta, variant ?? (meta.kind === 'icon' ? 'png' : 'thumb'));
  const box: CSSProperties = size ? { width: size, height: size, ...style } : (style ?? {});
  const cls = cx(
    'img-thumb',
    meta.kind === 'icon' ? 'img-icon' : 'img-concept',
    generated(meta) && 'img-ai',
    className,
  );
  if (!src)
    return (
      <span
        className={cx(cls, 'img-shimmer')}
        style={box}
        data-image={meta.id}
        data-kind={meta.kind}
        data-loading=""
        data-testid={testId}
        title={title}
      />
    );
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      className={cls}
      style={box}
      data-image={meta.id}
      data-kind={meta.kind}
      data-testid={testId}
      title={title}
    />
  );
}

/** Where an image is on its way: a shimmer on the glass, not a spinner. */
export function Shimmer({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}): ReactNode {
  return (
    <span
      className={cx('img-shimmer', className)}
      style={style}
      data-testid="image-shimmer"
      role="status"
      aria-label="Generating"
    />
  );
}
