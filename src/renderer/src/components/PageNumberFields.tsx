import type { PageNumberSpec } from '../../../shared/schemas'
import { ColorInput, Field, NumberInput, Select } from './ui'

export const DEFAULT_NUMBERS: PageNumberSpec = {
  position: 'bottom-center',
  start: 1,
  fontSize: 11,
  color: '#000000',
  format: 'n'
}

const POSITIONS: { value: PageNumberSpec['position']; label: string }[] = [
  { value: 'top-left', label: 'Top left' },
  { value: 'top-center', label: 'Top centre' },
  { value: 'top-right', label: 'Top right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom-center', label: 'Bottom centre' },
  { value: 'bottom-right', label: 'Bottom right' }
]

export function isValidNumbers(spec: PageNumberSpec): boolean {
  return Number.isInteger(spec.start) && spec.start >= 0 && spec.fontSize >= 4 && spec.fontSize <= 96
}

export function PageNumberFields({ value, onChange }: { value: PageNumberSpec; onChange: (value: PageNumberSpec) => void }) {
  const set = <K extends keyof PageNumberSpec>(key: K, next: PageNumberSpec[K]) => onChange({ ...value, [key]: next })
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Position">{(id) => <Select id={id} value={value.position} onChange={(next) => set('position', next)} options={POSITIONS} />}</Field>
      <Field label="Format">
        {(id) => (
          <Select
            id={id}
            value={value.format}
            onChange={(next) => set('format', next)}
            options={[
              { value: 'n', label: '1' },
              { value: 'page_n', label: 'Page 1' },
              { value: 'n_of_total', label: '1 of 12' }
            ]}
          />
        )}
      </Field>
      <Field label="Start at" error={Number.isInteger(value.start) && value.start >= 0 ? null : 'Use a whole number.'}>
        {(id) => <NumberInput id={id} value={value.start} min={0} onChange={(next) => set('start', next)} />}
      </Field>
      <Field label="Font size (pt)" error={value.fontSize >= 4 && value.fontSize <= 96 ? null : 'Between 4 and 96.'}>
        {(id) => <NumberInput id={id} value={value.fontSize} min={4} max={96} onChange={(next) => set('fontSize', next)} />}
      </Field>
      <Field label="Colour">{(id) => <ColorInput id={id} value={value.color} onChange={(next) => set('color', next)} />}</Field>
    </div>
  )
}
