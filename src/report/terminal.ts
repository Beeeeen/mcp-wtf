import type { Diagnosis, WtfReport } from '../types.js'

const useColor =
  !process.env['NO_COLOR'] && (process.env['FORCE_COLOR'] === '1' || process.stdout.isTTY === true)

const c = {
  reset: useColor ? '\x1b[0m' : '',
  bold: useColor ? '\x1b[1m' : '',
  red: useColor ? '\x1b[31m' : '',
  green: useColor ? '\x1b[32m' : '',
  yellow: useColor ? '\x1b[33m' : '',
  gray: useColor ? '\x1b[90m' : '',
}

const BADGE: Record<Diagnosis['verdict'], string> = {
  healthy: `${c.green} OK ${c.reset}`,
  warning: `${c.yellow}WARN${c.reset}`,
  broken: `${c.red}DEAD${c.reset}`,
}

function hostsOf(d: Diagnosis): string {
  return [...new Set(d.spec.sources.map((s) => s.split(' (')[0] ?? s))].join(', ')
}

export function renderTerminal(report: WtfReport): string {
  const lines: string[] = []
  const { diagnoses } = report

  lines.push('')
  const dead = report.broken
  const headline =
    dead === 0
      ? `all ${diagnoses.length} MCP server${diagnoses.length === 1 ? '' : 's'} are alive`
      : `${dead} of ${diagnoses.length} MCP server${diagnoses.length === 1 ? '' : 's'} ${dead === 1 ? 'is' : 'are'} broken -- here is exactly why`
  lines.push(`  ${c.bold}mcp-wtf${c.reset}  ${headline}`)
  lines.push(
    `  ${c.gray}${report.configsSearched.length} config${report.configsSearched.length === 1 ? '' : 's'} searched${report.configErrors.length ? `, ${report.configErrors.length} unreadable` : ''}${c.reset}`,
  )
  lines.push('')

  for (const err of report.configErrors) {
    lines.push(`  ${c.red}DEAD${c.reset}  ${c.bold}${err.path}${c.reset}`)
    lines.push(`        ${c.red}The config file itself is not valid JSON:${c.reset} ${err.error}`)
    lines.push(`        ${c.gray}Every server in this file is invisible to its host until this is fixed.${c.reset}`)
    lines.push('')
  }

  // Broken first -- they are what the user came for.
  const order: Diagnosis['verdict'][] = ['broken', 'warning', 'healthy']
  for (const verdict of order) {
    for (const d of diagnoses.filter((x) => x.verdict === verdict)) {
      const title =
        d.serverInfo?.name && d.serverInfo.name !== d.spec.name
          ? `${d.spec.name} ${c.gray}(${d.serverInfo.name}${d.serverInfo.version ? ` v${d.serverInfo.version}` : ''})${c.reset}`
          : d.spec.name
      const meta: string[] = [hostsOf(d)]
      if (d.toolCount !== undefined) meta.push(`${d.toolCount} tools`)
      if (d.connectMs !== undefined) meta.push(`${d.connectMs}ms`)
      lines.push(`  ${BADGE[d.verdict]}  ${c.bold}${title}${c.reset}  ${c.gray}${meta.join(', ')}${c.reset}`)

      for (const f of d.findings) {
        const mark = f.severity === 'fatal' ? `${c.red}x${c.reset}` : f.severity === 'warn' ? `${c.yellow}!${c.reset}` : `${c.gray}i${c.reset}`
        lines.push(`        ${mark} ${f.message}`)
        if (f.fix) {
          wrap(f.fix, 90).forEach((fl, i) => {
            lines.push(i === 0 ? `          ${c.green}fix:${c.reset} ${fl}` : `               ${fl}`)
          })
        }
        if (f.detail) {
          for (const dl of f.detail.split('\n').slice(0, 8)) lines.push(`          ${c.gray}${dl}${c.reset}`)
        }
      }
      lines.push('')
    }
  }

  const parts: string[] = []
  if (report.broken) parts.push(`${c.red}${report.broken} broken${c.reset}`)
  if (report.warnings) parts.push(`${c.yellow}${report.warnings} with warnings${c.reset}`)
  if (report.healthy) parts.push(`${c.green}${report.healthy} healthy${c.reset}`)
  lines.push(`  ${c.gray}${'-'.repeat(64)}${c.reset}`)
  lines.push(`  ${parts.join(`${c.gray}  |  ${c.reset}`)}   ${c.gray}${(report.durationMs / 1000).toFixed(1)}s${c.reset}`)
  lines.push('')
  return lines.join('\n')
}

function wrap(text: string, width: number): string[] {
  const words = text.split(' ')
  const out: string[] = []
  let line = ''
  for (const w of words) {
    if (line && line.length + w.length + 1 > width) {
      out.push(line)
      line = w
    } else {
      line = line ? `${line} ${w}` : w
    }
  }
  if (line) out.push(line)
  return out
}
