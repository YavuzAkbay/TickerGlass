/* global defineIndicator */
// ZigZag (reference ZigZag library semantics): swing pivots over `legs` bars
// on each side, confirmed `legs` bars late, joined by a line. A further
// extreme in the same direction moves the last pivot back in time, so past
// values repaint (setAt).
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
      color: '#2962ff',
      lineWidth: 2,
      connectGaps: true,
      showLastValue: false,
    },
    {
      type: 'shape',
      id: 'hiLbl',
      title: 'High Label',
      shape: 'labelDown',
      location: 'absolute',
      color: '#2962ff',
      textColor: '#ffffff',
      textFromValue: true,
    },
    {
      type: 'shape',
      id: 'loLbl',
      title: 'Low Label',
      shape: 'labelUp',
      location: 'absolute',
      color: '#2962ff',
      textColor: '#ffffff',
      textFromValue: true,
    },
  ],
  setup({ inputs, ta }) {
    const legs = Math.max(2, Math.floor(inputs.depth / 2));
    const { deviation, showPrice, extendToLastBar } = inputs;
    // All state carried across bars lives in ta.vars so live ticks can rewind it.
    // dir: 1 last pivot is a high, -1 a low, 0 none yet.
    const st = ta.vars({ dir: 0, bar: -1, price: NaN, prevBar: -1, prevPrice: NaN, extBar: -1 });

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

    function draw(c, bar, price, isHigh) {
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
      // Drop the provisional end point drawn on an earlier last bar.
      if (st.extBar >= 0 && st.extBar < c.i) {
        c.setAt('zz', st.extBar, NaN);
        st.extBar = -1;
      }
      const hi = swing(c.high, c.i, true);
      if (!Number.isNaN(hi)) candidate(c, c.i - legs, hi, 1);
      const lo = swing(c.low, c.i, false);
      if (!Number.isNaN(lo)) candidate(c, c.i - legs, lo, -1);
      if (extendToLastBar && c.isLast && st.bar >= 0) {
        c.set('zz', c.close[c.i]);
        st.extBar = c.i;
      }
    };
  },
});
