import { useEffect, useState } from 'react';
import type { RenderStats } from '@investopen/engine';
import { computeTimesOf, type ComputeStats } from './perf';
import type { ChartSession } from './session';

const POLL_MS = 500;

interface Sample {
  render: RenderStats;
  compute: ComputeStats;
}

const ms = (v: number) => v.toFixed(1);

/** Render and indicator timings of one chart (`?perf=1` only), refreshed twice a second. */
export function PerfOverlay({ session }: { session: ChartSession }) {
  const [sample, setSample] = useState<Sample | null>(null);
  useEffect(() => {
    const read = () =>
      setSample({
        render: session.chart.getRenderStats(),
        compute: computeTimesOf(session.id).stats(),
      });
    read();
    const timer = setInterval(read, POLL_MS);
    return () => clearInterval(timer);
  }, [session]);
  if (!sample) return null;
  const { render: r, compute: c } = sample;
  return (
    <div className="perf-overlay" aria-hidden="true">
      <div>
        frame {ms(r.lastFrameMs)} ms, avg {ms(r.avgFrameMs)} ms ({r.frames})
      </div>
      <div>
        layers {r.layersDrawn}, bars {r.barsDrawn}
      </div>
      <div>
        indicators {ms(c.lastMs)} ms, avg {ms(c.avgMs)} ms ({c.runs})
      </div>
    </div>
  );
}
