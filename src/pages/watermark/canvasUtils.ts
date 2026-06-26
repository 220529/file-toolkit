import type { BrushStroke } from "../../api/tauri";
import { clamp, getBrushDiameter } from "./utils";

export function paintBrushMaskCircle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  diameter: number,
  erase: boolean,
  scale: number
) {
  ctx.save();
  ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
  ctx.fillStyle = "rgba(43, 104, 241, 0.9)";
  ctx.beginPath();
  ctx.arc(x * scale, y * scale, (diameter * scale) / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function drawBrushMaskPreview(
  ctx: CanvasRenderingContext2D,
  strokes: BrushStroke[],
  scale: number,
  fallbackSize: number
) {
  let previousStroke: BrushStroke | null = null;

  strokes.forEach((stroke) => {
    const shouldConnect = previousStroke && !stroke.start && previousStroke.erase === stroke.erase;

    if (previousStroke && shouldConnect) {
      const diameter = Math.max(getBrushDiameter(previousStroke, fallbackSize), getBrushDiameter(stroke, fallbackSize));
      const dx = stroke.x - previousStroke.x;
      const dy = stroke.y - previousStroke.y;
      const distance = Math.hypot(dx, dy);

      if (distance <= Number.EPSILON) {
        paintBrushMaskCircle(ctx, stroke.x, stroke.y, diameter, stroke.erase, scale);
      } else {
        const step = Math.max(diameter / 4, 1);
        const steps = Math.max(1, Math.ceil(distance / step));

        for (let index = 0; index <= steps; index += 1) {
          const progress = index / steps;
          paintBrushMaskCircle(
            ctx,
            previousStroke.x + dx * progress,
            previousStroke.y + dy * progress,
            diameter,
            stroke.erase,
            scale
          );
        }
      }
    } else {
      paintBrushMaskCircle(ctx, stroke.x, stroke.y, getBrushDiameter(stroke, fallbackSize), stroke.erase, scale);
    }

    previousStroke = stroke;
  });
}

export function drawImageMagnifier(
  sourceImage: HTMLImageElement,
  targetCanvas: HTMLCanvasElement,
  sourceWidth: number,
  sourceHeight: number,
  ox: number,
  oy: number,
  targetSize: number,
  sampleSize: number
) {
  const ctx = targetCanvas.getContext("2d");
  if (!ctx) return;

  const drawWidth = sourceImage.naturalWidth || sourceImage.width;
  const drawHeight = sourceImage.naturalHeight || sourceImage.height;
  if (!drawWidth || !drawHeight || sourceWidth <= 0 || sourceHeight <= 0) return;

  const px = (ox / sourceWidth) * drawWidth;
  const py = (oy / sourceHeight) * drawHeight;
  const actualSampleSize = Math.min(sampleSize, Math.max(12, Math.min(drawWidth, drawHeight)));
  const sx = clamp(px - actualSampleSize / 2, 0, Math.max(0, drawWidth - actualSampleSize));
  const sy = clamp(py - actualSampleSize / 2, 0, Math.max(0, drawHeight - actualSampleSize));

  targetCanvas.width = targetSize;
  targetCanvas.height = targetSize;
  ctx.clearRect(0, 0, targetSize, targetSize);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sourceImage, sx, sy, actualSampleSize, actualSampleSize, 0, 0, targetSize, targetSize);

  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(targetSize / 2, 0);
  ctx.lineTo(targetSize / 2, targetSize);
  ctx.moveTo(0, targetSize / 2);
  ctx.lineTo(targetSize, targetSize / 2);
  ctx.stroke();

  ctx.strokeStyle = "rgba(15,23,42,0.28)";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, targetSize - 1, targetSize - 1);
  ctx.restore();
}
