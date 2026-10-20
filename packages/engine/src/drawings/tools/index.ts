// Built-in drawing tools. Importing this module registers them (chart.ts does).
// One file per tool, registered below in toolbar order.
import { registerDrawingTool } from '../registry';
import { abcd } from './abcd';
import { anchoredVp } from './anchored-vp';
import { arc } from './arc';
import { barReplica } from './bar-replica';
import { arrowLine } from './arrow-line';
import { downMarker } from './down-marker';
import { upMarker } from './up-marker';
import { arrowPointer } from './arrow-pointer';
import { brush } from './brush';
import { circle } from './circle';
import { crossLine } from './cross-line';
import { curve } from './curve';
import { cycleLines } from './cycle-lines';
import { cypher } from './cypher';
import { priceTimeMeasure } from './price-time-measure';
import { timeMeasure } from './time-measure';
import { splitChannel } from './split-channel';
import { sCurve } from './s-curve';
import { elliottCorrection } from './elliott-correction';
import { elliottDoubleCombo } from './elliott-double-combo';
import { elliottImpulse } from './elliott-impulse';
import { elliottTriangle } from './elliott-triangle';
import { elliottTripleCombo } from './elliott-triple-combo';
import { ellipse } from './ellipse';
import { extendedLine } from './extended-line';
import { rangeVp } from './range-vp';
import { priceTarget } from './price-target';
import { fibChannel } from './fib-channel';
import { fibCircles } from './fib-circles';
import { fibExtension } from './fib-extension';
import { fibRetracement } from './fib-retracement';
import { fibArcs } from './fib-arcs';
import { fibFan } from './fib-fan';
import { fibSpiral } from './fib-spiral';
import { fibTimeZone } from './fib-time-zone';
import { fibTimeExtension } from './fib-time-extension';
import { fibSector } from './fib-sector';
import { flatChannel } from './flat-channel';
import { pathSketch } from './path-sketch';
import { gannBox } from './gann-box';
import { gannFan } from './gann-fan';
import { gannSquare } from './gann-square';
import { gannGrid } from './gann-grid';
import { headShoulders } from './head-shoulders';
import { highlighter } from './highlighter';
import { horizontalLine } from './horizontal-line';
import { horizontalRay } from './horizontal-ray';
import { icon } from './icon';
import { pinnedText } from './pinned-text';
import { callout } from './callout';
import { comment } from './comment';
import { flag } from './flag';
import { image } from './image';
import { pinnedNote, note } from './note';
import { priceLabel } from './price-label';
import { priceTag } from './price-tag';
import { pin } from './pin';
import { table } from './table';
import { measuredLine } from './measured-line';
import { innerPitchfork } from './inner-pitchfork';
import { longPosition } from './long-position';
import { modifiedSchiffPitchfork } from './modified-schiff-pitchfork';
import { parallelChannel } from './parallel-channel';
import { path } from './path';
import { forkFan } from './fork-fan';
import { pitchfork } from './pitchfork';
import { polyline } from './polyline';
import { priceMeasure } from './price-measure';
import { swingProjection } from './swing-projection';
import { ray } from './ray';
import { rectangle } from './rectangle';
import { regressionTrend } from './regression-trend';
import { rotatedRectangle } from './rotated-rectangle';
import { schiffPitchfork } from './schiff-pitchfork';
import { shortPosition } from './short-position';
import { sineWave } from './sine-wave';
import { text } from './text';
import { threeDrives } from './three-drives';
import { cycleArcs } from './cycle-arcs';
import { trendAngle } from './trend-angle';
import { trendLine } from './trend-line';
import { triangle } from './triangle';
import { trianglePattern } from './triangle-pattern';
import { verticalLine } from './vertical-line';
import { xabcd } from './xabcd';

// lines
registerDrawingTool(trendLine);
registerDrawingTool(ray);
registerDrawingTool(measuredLine);
registerDrawingTool(extendedLine);
registerDrawingTool(trendAngle);
registerDrawingTool(horizontalLine);
registerDrawingTool(horizontalRay);
registerDrawingTool(verticalLine);
registerDrawingTool(crossLine);
registerDrawingTool(parallelChannel);
registerDrawingTool(regressionTrend);
registerDrawingTool(flatChannel);
registerDrawingTool(splitChannel);
registerDrawingTool(pitchfork);
registerDrawingTool(schiffPitchfork);
registerDrawingTool(modifiedSchiffPitchfork);
registerDrawingTool(innerPitchfork);
// fib
registerDrawingTool(fibRetracement);
registerDrawingTool(fibExtension);
registerDrawingTool(fibChannel);
registerDrawingTool(fibTimeZone);
registerDrawingTool(fibFan);
registerDrawingTool(fibTimeExtension);
registerDrawingTool(fibCircles);
registerDrawingTool(fibSpiral);
registerDrawingTool(fibArcs);
registerDrawingTool(fibSector);
registerDrawingTool(forkFan);
registerDrawingTool(gannBox);
registerDrawingTool(gannGrid);
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
registerDrawingTool(cycleLines);
registerDrawingTool(cycleArcs);
registerDrawingTool(sineWave);
// forecasting
registerDrawingTool(longPosition);
registerDrawingTool(shortPosition);
registerDrawingTool(priceTarget);
registerDrawingTool(barReplica);
registerDrawingTool(pathSketch);
registerDrawingTool(swingProjection);
registerDrawingTool(rangeVp);
registerDrawingTool(anchoredVp);
registerDrawingTool(priceMeasure);
registerDrawingTool(timeMeasure);
registerDrawingTool(priceTimeMeasure);
// shapes
registerDrawingTool(brush);
registerDrawingTool(highlighter);
registerDrawingTool(arrowPointer);
registerDrawingTool(arrowLine);
registerDrawingTool(upMarker);
registerDrawingTool(downMarker);
registerDrawingTool(rectangle);
registerDrawingTool(rotatedRectangle);
registerDrawingTool(path);
registerDrawingTool(circle);
registerDrawingTool(ellipse);
registerDrawingTool(polyline);
registerDrawingTool(triangle);
registerDrawingTool(arc);
registerDrawingTool(curve);
registerDrawingTool(sCurve);
// annotation
registerDrawingTool(text);
registerDrawingTool(pinnedText);
registerDrawingTool(note);
registerDrawingTool(pinnedNote);
registerDrawingTool(callout);
registerDrawingTool(comment);
registerDrawingTool(priceLabel);
registerDrawingTool(priceTag);
registerDrawingTool(pin);
registerDrawingTool(flag);
registerDrawingTool(table);
registerDrawingTool(image);
registerDrawingTool(icon);

export {
  abcd,
  anchoredVp,
  barReplica,
  rangeVp,
  priceTarget,
  pathSketch,
  swingProjection,
  pinnedNote,
  pinnedText,
  callout,
  comment,
  flag,
  image,
  note,
  priceLabel,
  priceTag,
  pin,
  table,
  arc,
  arrowLine,
  downMarker,
  arrowPointer,
  upMarker,
  brush,
  circle,
  crossLine,
  curve,
  cycleLines,
  cypher,
  priceTimeMeasure,
  timeMeasure,
  splitChannel,
  sCurve,
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
  fibArcs,
  fibFan,
  fibSpiral,
  fibTimeZone,
  fibTimeExtension,
  fibSector,
  flatChannel,
  gannBox,
  gannFan,
  gannSquare,
  gannGrid,
  headShoulders,
  highlighter,
  horizontalLine,
  horizontalRay,
  icon,
  measuredLine,
  innerPitchfork,
  longPosition,
  modifiedSchiffPitchfork,
  parallelChannel,
  path,
  forkFan,
  pitchfork,
  polyline,
  priceMeasure,
  ray,
  rectangle,
  regressionTrend,
  rotatedRectangle,
  schiffPitchfork,
  shortPosition,
  sineWave,
  text,
  threeDrives,
  cycleArcs,
  trendAngle,
  trendLine,
  triangle,
  trianglePattern,
  verticalLine,
  xabcd,
};
