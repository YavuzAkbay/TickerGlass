/* global defineIndicator */
// ZigZag (pivot test: no newer bar strictly beyond, no older bar beyond or equal): swing pivots over `legs` bars
// on each side, confirmed `legs` bars late, joined by a line. A pivot only
// counts as confirmed once price has moved `deviation` % against it since its
// bar; until then the last pivot stays hidden and the leg in progress is
// drawn as a dashed forecast line (`zzf`) from the previous pivot to the
// furthest extreme reached since, continuing to the last bar's close on
// request. A further extreme in the same direction moves the last pivot back
// in time, so past values repaint (setAt).
defineIndicator({
  id: 'my-zigzag',
  name: 'My ZigZag',
  shortName: 'MyZZ',
  category: 'other',
  overlay: true,
  repaints: true,
  inputs: {
    deviation: {
      kind: 'float',
      label: 'Price deviation for reversals (%)',
      default: 5,
      min: 0.00001,
      max: 100,
      step: 0.5,
    },
    depth: { kind: 'int', label: 'Pivot legs', default: 10, min: 2, max: 500 },
    extendToLastBar: { kind: 'bool', label: 'Extend to last bar', default: true },
    showPrice: { kind: 'bool', label: 'Display reversal price', default: true },
  },
  outputs: [
    {
      type: 'plot',
      id: 'zz',
      title: 'ZigZag',
      kind: 'line',
      color: '#6e9bd6',
      lineWidth: 2,
      connectGaps: true,
      showLastValue: false,
    },
    {
      type: 'plot',
      id: 'zzf',
      title: 'Forecast',
      kind: 'line',
      color: '#6e9bd6',
      lineWidth: 2,
      lineStyle: 'dashed',
      connectGaps: true,
      showLastValue: false,
    },
    {
      type: 'shape',
      id: 'hiLbl',
      title: 'High Label',
      shape: 'labelDown',
      location: 'absolute',
      color: '#6e9bd6',
      textColor: '#ffffff',
      textFromValue: true,
    },
    {
      type: 'shape',
      id: 'loLbl',
      title: 'Low Label',
      shape: 'labelUp',
      location: 'absolute',
      color: '#6e9bd6',
      textColor: '#ffffff',
      textFromValue: true,
    },
  ],
  setup({ inputs, ta }) {
    const legs = Math.max(2, Math.floor(inputs.depth / 2));
    const { deviation, showPrice, extendToLastBar } = inputs;
    // All state carried across bars lives in ta.vars so live ticks can rewind it.
    // dir: 1 last pivot is a high, -1 a low, 0 none yet.
    const st = ta.vars({ dir: 0, bar: -1, price: NaN, prevBar: -1, prevPrice: NaN });
    // Running low/high of the current pivot's reversal window [bar..i]: the
    // pivot is confirmed once the opposite extreme is `deviation` % away.
    const rev = ta.vars({ lo: Infinity, hi: -Infinity });
    // The last pivot whose vertex and label are hidden (not confirmed yet);
    // `high` is 1 for a pivot high, 0 for a low.
    const hid = ta.vars({ bar: -1, price: NaN, high: 0 });
    // Bars the previous last bar's forecast leg wrote, for cleanup.
    const fz = ta.vars({ start: -1, end: -1, tail: -1, lblBar: -1, lblHigh: 0 });

    // Value `legs` bars back if no newer bar of the window goes beyond it and
    // no older bar reaches it (the oldest of equal extremes wins); else NaN.
    function swing(values, i, isHigh) {
      if (i < 2 * legs) return NaN;
      const p = values[i - legs];
      if (Number.isNaN(p)) return NaN;
      for (let k = i - legs + 1; k <= i; k++) {
        if (isHigh ? values[k] > p : values[k] < p) return NaN;
      }
      for (let k = i - 2 * legs; k < i - legs; k++) {
        if (isHigh ? values[k] >= p : values[k] <= p) return NaN;
      }
      return p;
    }

    // A pivot was added, moved or restored at `bar`: draw it and restart the
    // reversal window over [bar..i] (like the built-in's set callback, this
    // fires on every add, move and same-bar restore).
    function draw(c, bar, price, isHigh) {
      rev.lo = Infinity;
      rev.hi = -Infinity;
      for (let k = bar; k <= c.i; k++) {
        if (c.low[k] < rev.lo) rev.lo = c.low[k];
        if (c.high[k] > rev.hi) rev.hi = c.high[k];
      }
      c.setAt('zz', bar, price);
      if (showPrice) c.setAt(isHigh ? 'hiLbl' : 'loLbl', bar, price);
    }

    function erase(c, bar, isHigh) {
      c.setAt('zz', bar, NaN);
      if (showPrice) c.setAt(isHigh ? 'hiLbl' : 'loLbl', bar, NaN);
    }

    function candidate(c, bar, price, dir) {
      const isHigh = dir > 0;
      if (st.dir === dir) {
        // Same direction: only a further extreme moves the last pivot.
        if (isHigh ? !(price > st.price) : !(price < st.price)) return;
        erase(c, st.bar, isHigh);
        // The bar also held the opposite pivot: show that one again.
        if (st.prevBar === st.bar) draw(c, st.prevBar, st.prevPrice, !isHigh);
        st.bar = bar;
        st.price = price;
        draw(c, bar, price, isHigh);
        return;
      }
      if (st.dir !== 0) {
        const pct = (100 * (price - st.price)) / Math.abs(st.price);
        const reversal = isHigh ? pct >= deviation : pct <= -deviation;
        if (!reversal) return;
      }
      st.prevBar = st.bar;
      st.prevPrice = st.price;
      st.dir = dir;
      st.bar = bar;
      st.price = price;
      draw(c, bar, price, isHigh);
    }

    return (c) => {
      // Drop what the previous last bar's forecast drew (its writes are committed now).
      if (fz.start >= 0 && fz.start < c.i) {
        c.setAt('zzf', fz.start, NaN);
        fz.start = -1;
      }
      if (fz.end >= 0 && fz.end < c.i) {
        c.setAt('zzf', fz.end, NaN);
        fz.end = -1;
      }
      if (fz.tail >= 0 && fz.tail < c.i) {
        c.setAt('zzf', fz.tail, NaN);
        fz.tail = -1;
      }
      if (fz.lblBar >= 0 && fz.lblBar < c.i) {
        c.setAt(fz.lblHigh ? 'hiLbl' : 'loLbl', fz.lblBar, NaN);
        fz.lblBar = -1;
      }

      const hi = swing(c.high, c.i, true);
      if (!Number.isNaN(hi)) candidate(c, c.i - legs, hi, 1);
      const lo = swing(c.low, c.i, false);
      if (!Number.isNaN(lo)) candidate(c, c.i - legs, lo, -1);

      if (st.bar >= 0) {
        if (c.low[c.i] < rev.lo) rev.lo = c.low[c.i];
        if (c.high[c.i] > rev.hi) rev.hi = c.high[c.i];
        const move = (100 * ((st.dir > 0 ? rev.lo : rev.hi) - st.price)) / Math.abs(st.price);
        const confirmed = st.dir > 0 ? move <= -deviation : move >= deviation;

        if (hid.bar >= 0) {
          // The hidden pivot is proven by its own reversal arriving, or by the
          // pivot added after it (that one moved `deviation` % beyond it).
          const proven =
            (hid.bar === st.bar &&
              hid.price === st.price &&
              hid.high === (st.dir > 0 ? 1 : 0) &&
              confirmed) ||
            (hid.bar === st.prevBar &&
              hid.price === st.prevPrice &&
              hid.high === (st.dir < 0 ? 1 : 0));
          if (proven) {
            c.setAt('zz', hid.bar, hid.price);
            if (showPrice) c.setAt(hid.high ? 'hiLbl' : 'loLbl', hid.bar, hid.price);
            hid.bar = -1;
          } else if (hid.bar !== st.bar) {
            // It moved away or was replaced: its bar stays as the core left it.
            hid.bar = -1;
          }
        }
        if (!confirmed && st.prevBar >= 0) {
          // Unconfirmed: hide the pivot; the forecast leg starts at the
          // previous one instead.
          if (hid.bar !== st.bar) {
            c.setAt('zz', st.bar, NaN);
            if (showPrice) c.setAt(st.dir > 0 ? 'hiLbl' : 'loLbl', st.bar, NaN);
          }
          hid.bar = st.bar;
          hid.price = st.price;
          hid.high = st.dir > 0 ? 1 : 0;
        }

        if (c.isLast) {
          // Dashed forecast leg: from the last confirmed pivot to the furthest
          // extreme reached since (oldest bar wins ties), whatever price does
          // in between. Once that extreme is behind the last bar, "Extend to
          // last bar" continues the line to the last close.
          const usePrev = !confirmed && st.prevBar >= 0;
          const startBar = usePrev ? st.prevBar : st.bar;
          const startPrice = usePrev ? st.prevPrice : st.price;
          const up = usePrev ? st.dir > 0 : st.dir < 0;
          let endBar = -1;
          let endPrice = up ? -Infinity : Infinity;
          for (let k = startBar + 1; k <= c.i; k++) {
            const v = up ? c.high[k] : c.low[k];
            if (up ? v > endPrice : v < endPrice) {
              endPrice = v;
              endBar = k;
            }
          }
          if (endBar >= 0) {
            c.setAt('zzf', startBar, startPrice);
            c.setAt('zzf', endBar, endPrice);
            fz.start = startBar;
            fz.end = endBar;
            fz.tail = -1;
            fz.lblBar = -1;
            if (extendToLastBar && endBar < c.i) {
              c.set('zzf', c.close[c.i]);
              fz.tail = c.i;
            }
            if (showPrice) {
              c.setAt(up ? 'hiLbl' : 'loLbl', endBar, endPrice);
              fz.lblBar = endBar;
              fz.lblHigh = up ? 1 : 0;
            }
          }
        }
      }
    };
  },
});
