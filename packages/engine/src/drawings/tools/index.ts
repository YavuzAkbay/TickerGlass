// Built-in drawing tools. Importing this module registers them (chart.ts does).
// One file per tool, registered below in toolbar order.
import { registerDrawingTool } from '../registry';
import { arrowLine } from './arrow-line';
import { brush } from './brush';
import { crossLine } from './cross-line';
import { cyclicLines } from './cyclic-lines';
import { datePriceRange } from './date-price-range';
import { dateRange } from './date-range';
import { disjointChannel } from './disjoint-channel';
import { extendedLine } from './extended-line';
import { fibChannel } from './fib-channel';
import { fibCircles } from './fib-circles';
import { fibExtension } from './fib-extension';
import { fibRetracement } from './fib-retracement';
import { fibSpeedArcs } from './fib-speed-arcs';
import { fibSpeedFan } from './fib-speed-fan';
import { fibSpiral } from './fib-spiral';
import { fibTimeZone } from './fib-time-zone';
import { fibTrendTime } from './fib-trend-time';
import { fibWedge } from './fib-wedge';
import { flatTopBottom } from './flat-top-bottom';
import { gannBox } from './gann-box';
import { gannFan } from './gann-fan';
import { gannSquare } from './gann-square';
import { gannSquareFixed } from './gann-square-fixed';
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
import { sineLine } from './sine-line';
import { text } from './text';
import { timeCycles } from './time-cycles';
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
registerDrawingTool(fibChannel);
registerDrawingTool(fibTimeZone);
registerDrawingTool(fibSpeedFan);
registerDrawingTool(fibTrendTime);
registerDrawingTool(fibCircles);
registerDrawingTool(fibSpiral);
registerDrawingTool(fibSpeedArcs);
registerDrawingTool(fibWedge);
registerDrawingTool(pitchfan);
registerDrawingTool(gannBox);
registerDrawingTool(gannSquareFixed);
registerDrawingTool(gannSquare);
registerDrawingTool(gannFan);
// patterns (cycles)
registerDrawingTool(cyclicLines);
registerDrawingTool(timeCycles);
registerDrawingTool(sineLine);
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
  cyclicLines,
  datePriceRange,
  dateRange,
  disjointChannel,
  extendedLine,
  fibChannel,
  fibCircles,
  fibExtension,
  fibRetracement,
  fibSpeedArcs,
  fibSpeedFan,
  fibSpiral,
  fibTimeZone,
  fibTrendTime,
  fibWedge,
  flatTopBottom,
  gannBox,
  gannFan,
  gannSquare,
  gannSquareFixed,
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
  sineLine,
  text,
  timeCycles,
  trendAngle,
  trendLine,
  verticalLine,
};
