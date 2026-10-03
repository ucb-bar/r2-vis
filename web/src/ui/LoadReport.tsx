import type { Trace } from '../data/trace'

/** What was loaded and how long it took (G1; the timeline replaces this view). */
export function LoadReport({ trace }: { trace: Trace }) {
  const { load } = trace
  return (
    <div className="panel">
      <h2>
        Loaded in {Math.round(load.totalMs)} ms with {load.workers} workers (decode{' '}
        {Math.round(load.decodeMs)} ms, bin levels and lane index {Math.round(load.deriveMs)} ms,
        worker time {Math.round(load.workerMs)} ms
        {load.fallbackUnits ? `, ${load.fallbackUnits} row groups through the fallback decoder` : ''})
      </h2>
      <table className="report">
        <thead>
          <tr><th>table</th><th>rows</th><th>row groups</th><th>MB</th><th>ready at ms</th></tr>
        </thead>
        <tbody>
          {load.tables.map((t) => (
            <tr key={t.name}>
              <td>{t.name}</td>
              <td>{t.rows.toLocaleString()}</td>
              <td>{t.groups}</td>
              <td>{(t.bytes / 1e6).toFixed(2)}</td>
              <td>{Math.round(t.ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
