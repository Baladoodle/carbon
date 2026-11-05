import type { ReactNode } from 'react';
import { useImageSrc } from '../../images/client';
import type { ImageMeta } from '../../images/model';
import { usePending } from '../../images/store';
import { describe } from '../../images/Thumb';

/**
 * A biome's concept art filling its glass panel (docs/IMAGES.md §6): cover,
 * cropped to the panel, under a soft scrim so the name and signature read
 * at every size. While a concept is being made, the panel shimmers.
 */
export function RegionArt({ id, concept }: { id: string; concept: ImageMeta | undefined }): ReactNode {
  const pending = usePending(id, 'concept');
  const src = useImageSrc(concept, 'png');
  if (pending) return <span className="climate-art-shimmer" data-testid="image-shimmer" aria-hidden="true" />;
  if (!concept) return null;
  return (
    <>
      <span
        className="climate-art"
        style={src ? { backgroundImage: `url("${src}")` } : undefined}
        data-loaded={src ? '' : undefined}
        data-image={concept.id}
        data-testid="climate-art"
        title={describe(concept)}
        aria-hidden="true"
      />
      <span className="climate-art-scrim" aria-hidden="true" />
    </>
  );
}
