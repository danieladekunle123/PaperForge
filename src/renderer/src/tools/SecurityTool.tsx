import { useEffect, useState } from 'react'
import { LockKeyhole, LockKeyholeOpen } from 'lucide-react'
import type { PermissionSpec } from '../../../shared/schemas'
import type { JobResult } from '../../../shared/types'
import { sourceRef } from '../store/workspace'
import { notify } from '../store/ui'
import { PasswordField, ToolHeader } from '../components/Shell'
import { Banner, Button, Field, Segmented, Toggle } from '../components/ui'
import { NoDocument, OutputSummary, saveAndRun, SourcePicker, usePdfSource, usePrimaryAction, useSignatureGate } from '../components/toolKit'
import { stripExtension } from '../lib/format'

const NO_PERMISSIONS: PermissionSpec = {
  print: true,
  printHighQuality: true,
  modify: false,
  copy: false,
  annotate: false,
  fillForms: true,
  assemble: false
}

const PERMISSION_LABELS: { key: keyof PermissionSpec; label: string }[] = [
  { key: 'print', label: 'Printing' },
  { key: 'printHighQuality', label: 'High-quality printing' },
  { key: 'copy', label: 'Copying text and images' },
  { key: 'modify', label: 'Editing content' },
  { key: 'annotate', label: 'Adding comments' },
  { key: 'fillForms', label: 'Filling forms' },
  { key: 'assemble', label: 'Inserting, rotating and deleting pages' }
]

export default function SecurityTool() {
  const { entry, ready, select } = usePdfSource()
  const [tab, setTab] = useState<'protect' | 'remove'>('protect')
  const [openPassword, setOpenPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [restrict, setRestrict] = useState(false)
  const [ownerPassword, setOwnerPassword] = useState('')
  const [permissions, setPermissions] = useState<PermissionSpec>(NO_PERMISSIONS)
  const [authPassword, setAuthPassword] = useState('')
  const [result, setResult] = useState<JobResult | null>(null)
  const gate = useSignatureGate(entry)

  const clearSecrets = () => {
    setOpenPassword('')
    setConfirm('')
    setOwnerPassword('')
    setAuthPassword('')
  }

  useEffect(() => {
    clearSecrets()
    setResult(null)
  }, [entry?.id, tab])

  const security = entry?.info?.security
  const mismatch = confirm.length > 0 && openPassword !== confirm
  const needsOwner = restrict && !ownerPassword
  const ownerSame = restrict && ownerPassword.length > 0 && ownerPassword === openPassword
  const hasSomething = openPassword.length > 0 || (restrict && ownerPassword.length > 0)
  const canProtect = !!entry && hasSomething && !mismatch && (!openPassword || confirm === openPassword) && !needsOwner && !ownerSame && gate.ok
  const canRemove = !!entry && !!security?.encrypted

  const protect = async () => {
    if (!entry) return
    const done = await saveAndRun({
      defaultName: `${stripExtension(entry.name)}-protected.pdf`,
      label: 'Protect',
      build: (outputId) => ({
        op: 'protect',
        params: {
          source: sourceRef(entry.id),
          ...(openPassword ? { userPassword: openPassword } : {}),
          ...(restrict ? { ownerPassword, permissions } : {}),
          output: { outputId }
        }
      })
    })
    if (done) {
      setResult(done)
      clearSecrets()
      notify('success', 'Protected copy saved with AES-256 encryption.')
    }
  }

  const remove = async () => {
    if (!entry) return
    const source = sourceRef(entry.id)
    const done = await saveAndRun({
      defaultName: `${stripExtension(entry.name)}-unlocked.pdf`,
      label: 'Remove encryption',
      build: (outputId) => ({
        op: 'unprotect',
        params: { source: { ...source, ...(authPassword ? { password: authPassword } : {}) }, output: { outputId } }
      })
    })
    if (done) {
      setResult(done)
      clearSecrets()
      notify('success', 'Saved a copy without encryption.')
    }
  }

  usePrimaryAction(tab === 'protect' ? 'Protect' : 'Remove encryption', tab === 'protect' ? canProtect : canRemove, () => void (tab === 'protect' ? protect() : remove()))

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="security-tool">
      <ToolHeader title="Password protection" description="Encrypt a copy with a password, or remove encryption when you are authorised to.">
        <Segmented
          label="Action"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'protect', label: 'Protect' },
            { value: 'remove', label: 'Remove encryption' }
          ]}
        />
        <SourcePicker entry={entry} ready={ready} select={select} />
      </ToolHeader>
      {!entry ? (
        <NoDocument title="Open a PDF">Passwords stay in memory while a job runs. They are never logged or saved.</NoDocument>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="mx-auto max-w-xl space-y-4">
            <p className="text-sm" data-testid="security-status">
              <span className="font-medium">{entry.name}</span>{' '}
              <span className="text-muted">· {security?.encrypted ? `Encrypted (${security.encryption})` : 'Not encrypted'}</span>
            </p>
            {tab === 'protect' ? (
              <>
                <section className="space-y-3 rounded-lg border border-line bg-surface p-4">
                  <Field label="Open password" hint="Needed to open the document. There is no way to recover it if lost.">
                    {(id) => <PasswordField id={id} value={openPassword} onChange={setOpenPassword} autoComplete="new-password" />}
                  </Field>
                  <Field label="Confirm open password" error={mismatch ? 'The passwords do not match.' : null}>
                    {(id) => <PasswordField id={id} value={confirm} onChange={setConfirm} autoComplete="new-password" />}
                  </Field>
                </section>
                <section className="space-y-3 rounded-lg border border-line bg-surface p-4">
                  <Toggle checked={restrict} onChange={setRestrict} label="Restrict what people can do" hint="Needs a separate owner password." />
                  {restrict && (
                    <>
                      <Field label="Owner password" error={ownerSame ? 'Must differ from the open password, or the restrictions have no effect.' : needsOwner ? 'Enter an owner password.' : null}>
                        {(id) => <PasswordField id={id} value={ownerPassword} onChange={setOwnerPassword} autoComplete="new-password" />}
                      </Field>
                      <fieldset className="space-y-1.5">
                        <legend className="mb-1 text-xs font-medium text-muted">Allowed without the owner password</legend>
                        {PERMISSION_LABELS.map(({ key, label }) => (
                          <Toggle key={key} checked={permissions[key]} onChange={(value) => setPermissions((current) => ({ ...current, [key]: value }))} label={label} />
                        ))}
                      </fieldset>
                      <Banner kind="warn">Permission flags are a request, not a lock. Whether they are enforced depends on the PDF viewer, and some software ignores them. Only the open password encrypts access to content.</Banner>
                    </>
                  )}
                </section>
                <Banner>Uses AES-256 encryption (PDF 2.0 style). Very old viewers may not be able to open the output.</Banner>
                {gate.notice}
                <Button variant="primary" icon={<LockKeyhole size={14} />} disabled={!canProtect} onClick={() => void protect()} data-testid="protect-run">
                  Choose location and protect
                </Button>
              </>
            ) : (
              <>
                {!security?.encrypted ? (
                  <Banner>This document is not encrypted, so there is nothing to remove.</Banner>
                ) : (
                  <section className="space-y-3 rounded-lg border border-line bg-surface p-4">
                    <p className="text-xs text-muted">
                      {security.fullAccess
                        ? 'You have full access to this document, so encryption can be removed.'
                        : 'This document has a separate owner password. Removing encryption needs that password, because the open password only grants the access its owner chose.'}
                    </p>
                    {!security.fullAccess && (
                      <Field label="Owner password">
                        {(id) => <PasswordField id={id} value={authPassword} onChange={setAuthPassword} />}
                      </Field>
                    )}
                    <Button variant="primary" icon={<LockKeyholeOpen size={14} />} disabled={!canRemove || (!security.fullAccess && !authPassword)} onClick={() => void remove()} data-testid="unprotect-run">
                      Choose location and remove
                    </Button>
                  </section>
                )}
                <Banner>PaperForge only removes encryption with a valid password. It cannot crack or bypass passwords.</Banner>
              </>
            )}
            {result && <OutputSummary result={result} />}
          </div>
        </div>
      )}
    </div>
  )
}
