import { BODY_HIT, inBox, setLineStyle, textFont } from '../draw-utils';
import { drawingImage } from '../images';
import { defineDrawingTool } from '../registry';

export const IMAGE_DEFAULTS = {
  src: '',
  keepAspect: true,
  showBorder: false,
  borderColor: '#787b86',
};

/** Whether `src` is an embedded image data URL (the only source the tool loads). */
export function isEmbeddedImage(src: unknown): src is string {
  return typeof src === 'string' && src.startsWith('data:image/');
}

/** Image (data URL in `style.src`) in the box spanned by two anchors. */
export const image = defineDrawingTool({
  type: 'image',
  name: 'Image',
  group: 'annotation',
  creation: { kind: 'points', count: 2 },
  shiftConstraint: 'none',
  defaults: IMAGE_DEFAULTS,
  properties: [
    { kind: 'image', key: 'src', label: 'Image' },
    { kind: 'bool', key: 'keepAspect', label: 'Keep aspect ratio' },
    { kind: 'bool', key: 'showBorder', label: 'Border', inline: 'border' },
    { kind: 'color', key: 'borderColor', label: 'Color', inline: 'border' },
  ],

  render(rc, g, s) {
    const [a, b] = g.points;
    if (!a || !b) return;
    const { ctx } = rc;
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    // Only embedded images load: an imported drawing must not make the chart fetch a URL.
    const img = isEmbeddedImage(s.src) ? drawingImage(s.src, rc.invalidate) : null;
    if (img && img.naturalWidth > 0 && img.naturalHeight > 0 && w > 0 && h > 0) {
      let dw = w;
      let dh = h;
      if (s.keepAspect) {
        const k = Math.min(w / img.naturalWidth, h / img.naturalHeight);
        dw = img.naturalWidth * k;
        dh = img.naturalHeight * k;
      }
      ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    } else {
      // Placeholder while empty / decoding / undecodable.
      ctx.fillStyle = 'rgba(120, 123, 134, 0.15)';
      ctx.fillRect(x, y, w, h);
      setLineStyle(ctx, s.borderColor, 1, 'dashed');
      ctx.strokeRect(x, y, w, h);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + w, y + h);
      ctx.moveTo(x + w, y);
      ctx.lineTo(x, y + h);
      ctx.stroke();
      ctx.font = textFont(rc.theme, 12);
      ctx.fillStyle = s.borderColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.src ? 'Image unavailable' : 'Image', x + w / 2, y + h / 2);
    }
    if (s.showBorder) {
      setLineStyle(ctx, s.borderColor, 1, 'solid');
      ctx.strokeRect(x, y, w, h);
    }
  },

  hitTest(g, _s, x, y, tol) {
    const [a, b] = g.points;
    return a && b && inBox(x, y, a.x, a.y, b.x, b.y, tol) ? BODY_HIT : null;
  },
});
