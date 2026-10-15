// Built-in drawing tools. Importing this module registers them (chart.ts does).
// One file per tool, registered below in toolbar order.
import { registerDrawingTool } from '../registry';
import { abcd } from './abcd';
import { arc } from './arc';
import { arrowLine } from './arrow-line';
import { arrowMarkDown } from './arrow-mark-down';
import { arrowMarkUp } from './arrow-mark-up';
import { arrowMarker } from './arrow-marker';
import { brush } from './brush';
import { circle } from './circle';
import { crossLine } from './cross-line';
import { curve } from './curve';
import { cyclicLines } from './cyclic-lines';
import { cypher } from './cypher';
import { datePriceRange } from './date-price-range';
import { dateRange } from './date-range';
import { disjointChannel } from './disjoint-channel';
import { doubleCurve } from './double-curve';
import { elliottCorrection } from './elliott-correction';
import { elliottDoubleCombo } from './elliott-double-combo';
import { elliottImpulse } from './elliott-impulse';
import { elliottTriangle } from './elliott-triangle';
import { elliottTripleCombo } from './elliott-triple-combo';
import { ellipse } from './ellipse';
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
import { headShoulders } from './head-shoulders';
import { highlighter } from './highlighter';
import { horizontalLine } from './horizontal-line';
import { horizontalRay } from './horizontal-ray';
import { icon } from './icon';
import { anchoredText } from './anchored-text';
import { callout } from './callout';
import { comment } from './comment';
import { flagMark } from './flag-mark';
import { image } from './image';
import { anchoredNote, note } from './note';
import { priceLabel } from './price-label';
import { priceNote } from './price-note';
import { signpost } from './signpost';
import { table } from './table';
import { infoLine } from './info-line';
import { insidePitchfork } from './inside-pitchfork';
import { longPosition } from './long-position';
import { modifiedSchiffPitchfork } from './modified-schiff-pitchfork';
import { parallelChannel } from './parallel-channel';
import { path } from './path';
import { pitchfan } from './pitchfan';
import { pitchfork } from './pitchfork';
import { polyline } from './polyline';
import { priceRange } from './price-range';
import { ray } from './ray';
import { rectangle } from './rectangle';
import { regressionTrend } from './regression-trend';
import { rotatedRectangle } from './rotated-rectangle';
import { schiffPitchfork } from './schiff-pitchfork';
import { shortPosition } from './short-position';
import { sineLine } from './sine-line';
import { text } from './text';
import { threeDrives } from './three-drives';
import { timeCycles } from './time-cycles';
import { trendAngle } from './trend-angle';
import { trendLine } from './trend-line';
import { triangle } from './triangle';
import { trianglePattern } from './triangle-pattern';
import { verticalLine } from './vertical-line';
import { xabcd } from './xabcd';

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
// patterns
registerDrawingTool(xabcd);
registerDrawingTool(cypher);
registerDrawingTool(headShoulders);
registerDrawingTool(abcd);
registerDrawingTool(trianglePattern);
registerDrawingTool(threeDrives);
registerDrawingTool(elliottImpulse);
registerDrawingTool(elliottCorrection);
registerDrawingTool(elliottTriangle);
registerDrawingTool(elliottDoubleCombo);
registerDrawingTool(elliottTripleCombo);
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
registerDrawingTool(highlighter);
registerDrawingTool(arrowMarker);
registerDrawingTool(arrowLine);
registerDrawingTool(arrowMarkUp);
registerDrawingTool(arrowMarkDown);
registerDrawingTool(rectangle);
registerDrawingTool(rotatedRectangle);
registerDrawingTool(path);
registerDrawingTool(circle);
registerDrawingTool(ellipse);
registerDrawingTool(polyline);
registerDrawingTool(triangle);
registerDrawingTool(arc);
registerDrawingTool(curve);
registerDrawingTool(doubleCurve);
// annotation
registerDrawingTool(text);
registerDrawingTool(anchoredText);
registerDrawingTool(note);
registerDrawingTool(anchoredNote);
registerDrawingTool(callout);
registerDrawingTool(comment);
registerDrawingTool(priceLabel);
registerDrawingTool(priceNote);
registerDrawingTool(signpost);
registerDrawingTool(flagMark);
registerDrawingTool(table);
registerDrawingTool(image);
registerDrawingTool(icon);

export {
  abcd,
  anchoredNote,
  anchoredText,
  callout,
  comment,
  flagMark,
  image,
  note,
  priceLabel,
  priceNote,
  signpost,
  table,
  arc,
  arrowLine,
  arrowMarkDown,
  arrowMarker,
  arrowMarkUp,
  brush,
  circle,
  crossLine,
  curve,
  cyclicLines,
  cypher,
  datePriceRange,
  dateRange,
  disjointChannel,
  doubleCurve,
  elliottCorrection,
  elliottDoubleCombo,
  elliottImpulse,
  elliottTriangle,
  elliottTripleCombo,
  ellipse,
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
  headShoulders,
  highlighter,
  horizontalLine,
  horizontalRay,
  icon,
  infoLine,
  insidePitchfork,
  longPosition,
  modifiedSchiffPitchfork,
  parallelChannel,
  path,
  pitchfan,
  pitchfork,
  polyline,
  priceRange,
  ray,
  rectangle,
  regressionTrend,
  rotatedRectangle,
  schiffPitchfork,
  shortPosition,
  sineLine,
  text,
  threeDrives,
  timeCycles,
  trendAngle,
  trendLine,
  triangle,
  trianglePattern,
  verticalLine,
  xabcd,
};
