'use client'

import { useState } from 'react'
import { usePoll } from '@/lib/api'
import type { ResearchState, StrategyCandidateRow } from '@/lib/types'
import { Badge, EmptyState, Panel, Tab, TabList, TabPanel, Tabs } from '@/components/ui/kit'
import { ago, titleCase } from '@/lib/format'
import { GitBranch } from 'lucide-react'

export function StrategyCandidates({ instId }: { instId: string }) {
  const [tab, setTab] = useState('candidates')
  const candidates = usePoll<{ rows: StrategyCandidateRow[] }>(instId ? `/candidates?instId=${encodeURIComponent(instId)}&limit=80` : null, 5000)
  const research = usePoll<ResearchState>('/research', 12000)
  const latest = candidates.data?.rows ?? []
  const eligible = latest.filter((row) => row.eligible).slice(0, 8)
  const rejected = latest.filter((row) => !row.eligible).slice(0, 8)
  return <Panel title="Explicit playbooks" subtitle="prerequisites, triggers and rejection reasons" data-testid="strategy-panel" actions={<Badge tone={research.data?.validationState === 'VALIDATED' ? 'bull' : 'warning'} data-testid="advisory-model-state">{research.data?.validationState ?? 'NO_VALIDATED_MODEL'}</Badge>} bodyClassName="p-0">
    <Tabs value={tab} onChange={setTab}><TabList><Tab id="candidates" count={eligible.length}>Candidates</Tab><Tab id="rejected" count={rejected.length}>Rejected</Tab></TabList>
      <TabPanel id="candidates"><Rows rows={eligible} empty="No playbook currently clears every prerequisite and trigger." /></TabPanel>
      <TabPanel id="rejected"><Rows rows={rejected} empty="No rejected candidate has been persisted yet." /></TabPanel>
    </Tabs>
  </Panel>
}

function Rows({ rows, empty }: { rows: StrategyCandidateRow[]; empty: string }) {
  if (!rows.length) return <EmptyState icon={<GitBranch className="h-5 w-5" />} title="No rows"><span>{empty}</span></EmptyState>
  return <div className="divide-y divide-border/60" data-testid="strategy-table">{rows.map((row) => <div key={row.id} className="px-3 py-2"><div className="flex items-center gap-1.5"><Badge tone={row.side === 'LONG' ? 'bull' : 'bear'}>{row.side}</Badge><span className="text-[11px] font-medium">{titleCase(row.playbook)}</span><span className="num ml-auto text-[10px] text-muted-foreground">{ago(row.observed_at)}</span></div><p className="mt-1 text-[10px] leading-snug text-muted-foreground">{row.eligible ? [...(row.payload.prerequisites ?? []), ...(row.payload.triggers ?? [])].map(titleCase).join(' · ') : row.reasons.map(titleCase).join(' · ')}</p></div>)}</div>
}
