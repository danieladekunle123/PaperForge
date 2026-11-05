import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { DropOverlay, JobBar, PasswordPrompt, Sidebar, TitleBar, Toasts } from './components/Shell'
import { AssemblyTool } from './tools/AssemblyTool'
import { installJobListener } from './store/jobs'
import { useSettings } from './store/settings'
import { useUi, type ToolId } from './store/ui'
import { useWorkspace } from './store/workspace'
import { isEditableTarget } from './lib/format'

const MergeTool = lazy(() => import('./tools/MergeTool'))
const SplitTool = lazy(() => import('./tools/SplitTool'))
const CompressTool = lazy(() => import('./tools/CompressTool'))
const ImagesTool = lazy(() => import('./tools/ImagesTool'))
const PageNumbersTool = lazy(() => import('./tools/PageNumbersTool'))
const WatermarkTool = lazy(() => import('./tools/WatermarkTool'))
const SignTool = lazy(() => import('./tools/SignTool'))
const SecurityTool = lazy(() => import('./tools/SecurityTool'))
const TextTool = lazy(() => import('./tools/TextTool'))
const InfoTool = lazy(() => import('./tools/InfoTool'))
const SettingsView = lazy(() => import('./tools/SettingsView'))

const TOOLS: Record<Exclude<ToolId, 'assembly'>, React.ComponentType> = {
  merge: MergeTool,
  split: SplitTool,
  compress: CompressTool,
  images: ImagesTool,
  numbers: PageNumbersTool,
  watermark: WatermarkTool,
  sign: SignTool,
  security: SecurityTool,
  text: TextTool,
  info: InfoTool,
  settings: SettingsView
}

export default function App() {
  const tool = useUi((state) => state.tool)
  const importDropped = useWorkspace((state) => state.importDropped)
  const importWithDialog = useWorkspace((state) => state.importWithDialog)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)

  useEffect(() => {
    void useSettings.getState().load()
    return installJobListener()
  }, [])

  // Drag and drop of files from the operating system, anywhere in the window.
  useEffect(() => {
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false
    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      dragDepth.current++
      setDragging(true)
    }
    const onLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragging(false)
    }
    const onOver = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault()
    }
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      const files = [...(event.dataTransfer?.files ?? [])]
      if (files.length) void importDropped(files)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [importDropped])

  // Shortcuts that apply everywhere. Tools register what Ctrl+S means for them.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'o' && useUi.getState().modalDepth === 0) {
        event.preventDefault()
        void importWithDialog('any')
      } else if (key === 's') {
        event.preventDefault()
        if (useUi.getState().modalDepth > 0) return
        const primary = useUi.getState().primary
        if (primary?.enabled && (!isEditableTarget(event.target) || (event.target as HTMLElement).tagName !== 'TEXTAREA')) primary.run()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [importWithDialog])

  const Tool = tool === 'assembly' ? null : TOOLS[tool]

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Assembly stays mounted so its grid and scroll position survive a tool switch. */}
          <div className={tool === 'assembly' ? 'flex min-h-0 flex-1' : 'hidden'}>
            <AssemblyTool />
          </div>
          {Tool && (
            <Suspense fallback={null}>
              <Tool />
            </Suspense>
          )}
        </main>
      </div>
      <JobBar />
      <Toasts />
      <PasswordPrompt />
      {dragging && <DropOverlay />}
    </div>
  )
}
