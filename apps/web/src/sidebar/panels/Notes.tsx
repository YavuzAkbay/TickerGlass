import { useUiStore } from '../../store/ui';

export function Notes() {
  const notes = useUiStore((s) => s.notes);
  return (
    <div className="rs-notes">
      <textarea
        className="rs-notes-input"
        aria-label="Notes"
        placeholder="Write your trading notes here..."
        value={notes}
        spellCheck
        onChange={(e) => useUiStore.getState().set({ notes: e.target.value })}
      />
      <div className="rs-notes-foot">
        {notes.length
          ? `${notes.length.toLocaleString()} characters · saved automatically`
          : 'Saved automatically'}
      </div>
    </div>
  );
}
