export type HintAnchor = { x: number; y: number; width: number; height: number };

/** Keep the speech bubble beside its anchor, including small phones and zoom. */
export function metadataHintPosition(anchor: HintAnchor, viewport: { width: number; height: number }, desiredHeight = 180) {
  const margin = 12;
  const gap = 8;
  const width = Math.max(1, Math.min(340, viewport.width - margin * 2));
  const above = Math.max(0, anchor.y - margin - gap);
  const below = Math.max(0, viewport.height - margin - anchor.y - anchor.height - gap);
  const placement = below < desiredHeight && above > below ? 'above' : 'below';
  const maxHeight = Math.max(1, Math.min(300, placement === 'above' ? above : below));
  const height = Math.min(desiredHeight, maxHeight);
  const left = Math.max(margin, Math.min(anchor.x + anchor.width / 2 - width / 2, viewport.width - margin - width));
  const top = placement === 'above' ? anchor.y - gap - height : anchor.y + anchor.height + gap;
  return { left, top, width, maxHeight, placement,
    arrowLeft: Math.max(16, Math.min(width - 16, anchor.x + anchor.width / 2 - left)) };
}
