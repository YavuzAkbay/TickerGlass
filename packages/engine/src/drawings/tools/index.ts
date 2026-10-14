// Built-in drawing tools. Importing this module registers them (chart.ts does).
// One file per tool, registered below in toolbar order.
import { registerDrawingTool } from '../registry';
import { arrowLine } from './arrow-line';
import { brush } from './brush';
import { crossLine } from './cross-line';
import { datePriceRange } from './date-price-range';
import { dateRange } from './date-range';
import { disjointChannel } from './disjoint-channel';
import { extendedLine } from './extended-line';
import { fibExtension } from './fib-extension';
import { fibRetracement } from './fib-retracement';
import { flatTopBottom } from './flat-top-bottom';
import { horizontalLine } from './horizontal-line';
import { horizontalRay } from './horizontal-ray';
import { icon } from './icon';
import { infoLine } from './info-line';
import { insidePitchfork } from './inside-pitchfork';
import { longPosition } from './long-position';
import { modifiedSchiffPitchfork } from './modified-schiff-pitchfork';
import { parallelChannel } from './parallel-channel';
import { pitchfan } from './pitchfan';
import { pitchfork } from './pitchfork';
import { priceRange } from './price-range';
import { ray } from './ray';
import { rectangle } from './rectangle';
import { regressionTrend } from './regression-trend';
import { schiffPitchfork } from './schiff-pitchfork';
import { shortPosition } from './short-position';
import { text } from './text';
import { trendAngle } from './trend-angle';
import { trendLine } from './trend-line';
import { verticalLine } from './vertical-line';

// lines
registerDrawingTool(trendLine);
registerDrawingTool(ray);
registerDrawingTool(infoLine);
registerDrawingTool(extendedLine);
registerDrawingTool(trendAngle);
registerDrawingTool(horizontalLine);
registerDrawingTool(horizontalRay);
registerDrawingTool(verticalLine);
registerDrawingTool(crossLine);
registerDrawingTool(parallelChannel);
registerDrawingTool(regressionTrend);
registerDrawingTool(flatTopBottom);
registerDrawingTool(disjointChannel);
registerDrawingTool(pitchfork);
registerDrawingTool(schiffPitchfork);
registerDrawingTool(modifiedSchiffPitchfork);
registerDrawingTool(insidePitchfork);
// fib
registerDrawingTool(fibRetracement);
registerDrawingTool(fibExtension);
registerDrawingTool(pitchfan);
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
  disjointChannel,
  extendedLine,
  fibExtension,
  fibRetracement,
  flatTopBottom,
  horizontalLine,
  horizontalRay,
  icon,
  infoLine,
  insidePitchfork,
  longPosition,
  modifiedSchiffPitchfork,
  parallelChannel,
  pitchfan,
  pitchfork,
  priceRange,
  ray,
  rectangle,
  regressionTrend,
  schiffPitchfork,
  shortPosition,
  text,
  trendAngle,
  trendLine,
  verticalLine,
};
