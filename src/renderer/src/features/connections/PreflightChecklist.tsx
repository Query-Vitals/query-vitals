/**
 * A human-readable "can we actually monitor this?" checklist built from a
 * {@link ConnectionTestResult}. Each missing capability becomes a card with a
 * plain-language reason and a copy-ready fix (GRANT / config / steps), so the
 * user knows exactly what to do instead of staring at an empty query table.
 *
 * Shared by the connection form (after Test) and the monitoring screen
 * (preflight before Start).
 */

import type { ConnectionTestResult } from '@shared/types/database';
import { CodeBlock } from '@renderer/shared/ui';
import { cx } from '@renderer/shared/lib/format';
import { fixForIssue, type ConnectionContext } from './capability-guidance';

interface PreflightChecklistProps {
  result: ConnectionTestResult;
  context: ConnectionContext;
  /** Heading shown above the checklist (omit to render headingless). */
  title?: string;
}

function CheckRow({
  ok,
  label,
  detail,
}: {
  ok: boolean;
  label: string;
  detail?: string;
}): JSX.Element {
  return (
    <div className="flex items-start gap-2">
      <span
        className={cx(
          'mt-0.5 inline-flex h-4 w-4 flex-none items-center justify-center rounded-full text-[10px] font-bold',
          ok ? 'bg-good/20 text-good' : 'bg-warn/20 text-warn',
        )}
        aria-hidden
      >
        {ok ? '✓' : '!'}
      </span>
      <span className="text-xs text-slate-200">
        {label}
        {detail && <span className="text-slate-400"> — {detail}</span>}
      </span>
    </div>
  );
}

export function PreflightChecklist({
  result,
  context,
  title,
}: PreflightChecklistProps): JSX.Element {
  if (!result.ok) {
    return (
      <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">
        Couldn’t reach the database{result.error ? `: ${result.error}` : ''}. Check the host, port,
        and credentials, then try again.
      </div>
    );
  }

  const issues = result.capabilityIssues ?? [];
  const capable = result.monitoringCapable ?? issues.length === 0;

  return (
    <div className="space-y-3">
      {title && <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</h3>}

      <div className="space-y-1.5">
        <CheckRow
          ok
          label="Connected"
          detail={[
            result.serverVersion ? `v${result.serverVersion}` : undefined,
            result.latencyMs != null ? `${result.latencyMs} ms` : undefined,
          ]
            .filter(Boolean)
            .join(' · ')}
        />
        <CheckRow
          ok={capable}
          label={capable ? 'Monitoring ready' : 'Monitoring needs setup'}
          detail={
            capable
              ? 'queries will appear once they run against the database'
              : `${issues.length} thing${issues.length === 1 ? '' : 's'} to fix below`
          }
        />
      </div>

      {!capable &&
        issues.map((issue) => {
          const fix = fixForIssue(issue, context);
          return (
            <div
              key={issue.code}
              className="space-y-2 rounded-md border border-warn/30 bg-warn/5 px-3 py-2.5"
            >
              <div>
                <p className="text-xs font-semibold text-slate-100">{fix.title}</p>
                <p className="mt-0.5 text-xs text-slate-400">{fix.why}</p>
              </div>

              {fix.steps && (
                <ol className="ml-4 list-decimal space-y-0.5 text-xs text-slate-300">
                  {fix.steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              )}

              {fix.command && (
                <div className="space-y-1">
                  <CodeBlock code={fix.command} copyable maxHeightClass="max-h-40" />
                  {fix.commandNote && <p className="text-[11px] text-slate-500">{fix.commandNote}</p>}
                </div>
              )}
            </div>
          );
        })}

      {capable && (
        <p className="text-[11px] text-slate-500">
          Idle databases show nothing until traffic arrives — run a few queries to see them captured.
        </p>
      )}
    </div>
  );
}

export default PreflightChecklist;
