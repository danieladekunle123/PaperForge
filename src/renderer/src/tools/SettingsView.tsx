import { useEffect, useState } from 'react'
import { ExternalLink as ExternalLinkIcon, FolderOpen } from 'lucide-react'
import type { AppInfo, ExternalLink } from '../../../shared/types'
import { clearThumbnailCache } from '../lib/pdfEngine'
import { useSettings } from '../store/settings'
import { notify } from '../store/ui'
import { ToolHeader } from '../components/Shell'
import { Button, Field, Modal, NumberInput, Segmented, Select, Toggle } from '../components/ui'

function ExternalButton({ link, children }: { link: ExternalLink; children: React.ReactNode }) {
  return (
    <button type="button" onClick={() => void window.paperforge.openExternal(link)} className="inline-flex items-center gap-1 text-accent hover:underline">
      {children}
      <ExternalLinkIcon size={12} aria-hidden />
    </button>
  )
}

export default function SettingsView() {
  const settings = useSettings((state) => state.settings)
  const update = useSettings((state) => state.update)
  const replace = useSettings((state) => state.replace)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [notices, setNotices] = useState<string | null>(null)
  const [dpi, setDpi] = useState(settings.defaultDpi)

  useEffect(() => {
    void window.paperforge.getAppInfo().then(setInfo)
  }, [])

  const dpiValid = Number.isInteger(dpi) && dpi >= 36 && dpi <= 1200

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="settings-view">
      <ToolHeader title="Settings" />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-2xl space-y-4">
          <section className="space-y-4 rounded-lg border border-line bg-surface p-4">
            <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">Preferences</h2>
            <Field label="Theme">
              {() => (
                <Segmented
                  label="Theme"
                  value={settings.theme}
                  onChange={(theme) => void update({ theme })}
                  options={[
                    { value: 'dark', label: 'Dark' },
                    { value: 'light', label: 'Light' }
                  ]}
                />
              )}
            </Field>
            <Field label="Default export folder" hint="Save dialogs and folder pickers open here first.">
              {() => (
                <div className="flex items-center gap-2">
                  <span className="selectable min-w-0 flex-1 truncate text-sm" title={settings.defaultExportDir ?? undefined} data-testid="default-export-dir">
                    {settings.defaultExportDir ?? 'Not set'}
                  </span>
                  <Button size="sm" icon={<FolderOpen size={13} />} onClick={() => void window.paperforge.chooseDefaultExportDir().then(replace)}>
                    Choose
                  </Button>
                  {settings.defaultExportDir && (
                    <Button size="sm" variant="ghost" onClick={() => void window.paperforge.clearDefaultExportDir().then(replace)}>
                      Clear
                    </Button>
                  )}
                </div>
              )}
            </Field>
            <div className="grid max-w-md grid-cols-2 gap-4">
              <Field label="Default image resolution (DPI)" error={dpiValid ? null : 'Between 36 and 1200.'}>
                {(id) => (
                  <NumberInput
                    id={id}
                    value={dpi}
                    min={36}
                    max={1200}
                    step={10}
                    onChange={(value) => {
                      setDpi(value)
                      if (Number.isInteger(value) && value >= 36 && value <= 1200) void update({ defaultDpi: value })
                    }}
                  />
                )}
              </Field>
              <Field label="Default compression">
                {(id) => (
                  <Select
                    id={id}
                    value={settings.defaultCompression}
                    onChange={(defaultCompression) => void update({ defaultCompression })}
                    options={[
                      { value: 'lossless', label: 'Lossless' },
                      { value: 'balanced', label: 'Balanced' },
                      { value: 'strong', label: 'Stronger' }
                    ]}
                  />
                )}
              </Field>
            </div>
          </section>

          <section className="space-y-3 rounded-lg border border-line bg-surface p-4">
            <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">Privacy</h2>
            <Toggle
              checked={settings.recentFilesEnabled}
              onChange={(recentFilesEnabled) => void update({ recentFilesEnabled })}
              label="Remember recently imported files"
              hint="Off by default. When on, file paths are stored in the app-data folder on this computer. Document contents never are."
            />
            <Button
              data-testid="clear-history"
              onClick={() =>
                void window.paperforge.clearHistoryAndCache().then(() => {
                  clearThumbnailCache()
                  notify('success', 'Recent files and caches cleared.')
                })
              }
            >
              Clear history and cache
            </Button>
            <p className="text-xs text-muted">PaperForge has no accounts, analytics or cloud features, and it makes no network requests while you work. Thumbnails are held in memory and dropped when the app closes.</p>
          </section>

          <section className="space-y-3 rounded-lg border border-line bg-surface p-4">
            <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">About</h2>
            {info && (
              <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1 text-xs" data-testid="about">
                <dt className="text-subtle">PaperForge</dt>
                <dd>{info.version}</dd>
                <dt className="text-subtle">Electron</dt>
                <dd>{info.electron}</dd>
                <dt className="text-subtle">Chromium</dt>
                <dd>{info.chromium}</dd>
                <dt className="text-subtle">PyMuPDF / MuPDF</dt>
                <dd>{info.worker ? `${info.worker.pymupdf} / ${info.worker.mupdf}` : info.workerAvailable ? 'Starting…' : 'Worker unavailable'}</dd>
                <dt className="text-subtle">Pillow</dt>
                <dd>{info.worker?.pillow ?? '–'}</dd>
              </dl>
            )}
            <p className="text-xs leading-relaxed text-muted">
              PaperForge is free software under the <ExternalButton link="agpl">GNU AGPL 3.0 or later</ExternalButton>. It includes PyMuPDF and MuPDF, which are available under the AGPL or a commercial licence from Artifex (<ExternalButton link="pymupdf-licensing">details</ExternalButton>). Corresponding source: <ExternalButton link="repository">project repository</ExternalButton>.
            </p>
            <Button
              data-testid="show-notices"
              onClick={() => void window.paperforge.getNotices().then(setNotices)}
            >
              Dependency notices
            </Button>
          </section>
        </div>
      </div>
      {notices !== null && (
        <Modal title="Dependency notices" onClose={() => setNotices(null)} width="max-w-3xl">
          <pre className="selectable max-h-[65vh] overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted">{notices}</pre>
        </Modal>
      )}
    </div>
  )
}
