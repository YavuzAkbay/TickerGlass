// Built-in drawing tools. Importing this module registers them (chart.ts does).
// One file per tool, registered below in toolbar order.
import { registerDrawingTool } from '../registry';
import { arrowLine } from './arrow-line';
import { brush } from './brush';
import { crossLine } from './cross-line';
import { datePriceRange } from './date-price-range';
import { dateRange } from './date-range';
import { extendedLine } from './extended-line';
import { fibExtension } from './fib-extension';
import { fibRetracement } from './fib-retracement';
import { horizontalLine } from './horizontal-line';
import { horizontalRay } from './horizontal-ray';
import { icon } from './icon';
import { infoLine } from './info-line';
import { longPosition } from './long-position';
import { parallelChannel } from './parallel-channel';
import { priceRange } from './price-range';
import { ray } from './ray';
import { rectangle } from './rectangle';
import { shortPosition } from './short-position';
import { text } from './text';
import { trendLine } from './trend-line';
import { verticalLine } from './vertical-line';

// lines
registerDrawingTool(trendLine);
registerDrawingTool(ray);
registerDrawingTool(infoLine);
registerDrawingTool(extendedLine);
registerDrawingTool(horizontalLine);
registerDrawingTool(horizontalRay);
registerDrawingTool(verticalLine);
registerDrawingTool(crossLine);
registerDrawingTool(parallelChannel);
// fib
registerDrawingTool(fibRetracement);
registerDrawingTool(fibExtension);
// forecasting
registerDrawingTool(longPosition);
registerDrawingTool(shortPosition);
registerDrawingTool(priceRange);
registerDrawingTool(dateRange);
registerDrawingTool(datePriceRange);
// shapes
registerDrawingTool(brush);
registerDrawingTool(arrowLine);
registerDrawingTool(rectangle);
// annotation
registerDrawingTool(text);
registerDrawingTool(icon);

export {
  arrowLine,
  brush,
  crossLine,
  datePriceRange,
  dateRange,
  extendedLine,
  fibExtension,
  fibRetracement,
  horizontalLine,
  horizontalRay,
  icon,
  infoLine,
  longPosition,
  parallelChannel,
  priceRange,
  ray,
  rectangle,
  shortPosition,
  text,
  trendLine,
  verticalLine,
};
