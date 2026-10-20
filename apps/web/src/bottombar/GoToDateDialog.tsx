import { useState } from 'react';
import { getChart } from '../store/chart';
import { Modal } from '../ui/Modal';
import { toast } from '../ui/Toast';
import './RangeStrip.css';

type Tab = 'date' | 'range';

const today = () => new Date().toISOString().slice(0, 10);

function toUnix(date: string, time: string): number {
  // Interpreted in the browser's local zone.
  return new Date(`${date}T${time || '00:00'}`).getTime() / 1000;
}

export default function GoToDateDialog({ onClose }: { onClose: () => void; arg?: unknown }) {
  const [tab, setTab] = useState<Tab>('date');
  const [date, setDate] = useState(today);
  const [time, setTime] = useState('00:00');
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 3);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(today);

  const go = async () => {
    const chart = getChart();
    if (!chart) return;
    onClose();
    try {
      if (tab === 'date') await chart.scrollToTime(toUnix(date, time));
      else {
        const a = toUnix(from, '00:00');
        const b = toUnix(to, '23:59');
        if (!(a < b)) {
          toast('Start must be before end', 'error');
          return;
        }
        await chart.setVisibleTimeRange(a, b);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  return (
    <Modal
      title="Go to"
      onClose={onClose}
      width={420}
      footer={
        <>
          <button type="button" className="io-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="io-btn io-btn-primary" onClick={go}>
            Go to
          </button>
        </>
      }
    >
      <div className="gtd-tabs">
        <button
          type="button"
          className={tab === 'date' ? 'active' : ''}
          onClick={() => setTab('date')}
        >
          Date
        </button>
        <button
          type="button"
          className={tab === 'range' ? 'active' : ''}
          onClick={() => setTab('range')}
        >
          Custom range
        </button>
      </div>
      <form
        className="gtd-body"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        {tab === 'date' ? (
          <div className="gtd-row">
            <input
              className="io-input"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              autoFocus
            />
            <input
              className="io-input"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </div>
        ) : (
          <div className="gtd-row">
            <input
              className="io-input"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              autoFocus
            />
            <span>—</span>
            <input
              className="io-input"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
