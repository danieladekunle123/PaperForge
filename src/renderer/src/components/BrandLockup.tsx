// Outlines copied from the logo masters: the symbol is branding/icons/source/app-icon-24.svg without its tile, drawn
// to land on a 24 px grid, and the name is branding/logo/wordmark. Colours follow the theme through --pf-logo-*.
const SHEETS =
  'M32 10.67L123.58 10.67L166.25 53.33L74.67 53.33L74.67 202.67L32 160ZM224 245.33L132.42 245.33L89.75 202.67L181.33 202.67L181.33 53.33L224 96Z'
const PAGE = 'M85.33 64L149.33 64L170.67 85.33L170.67 192L85.33 192Z'
const WORDMARK =
  'M16 156L16 16L62 16A42 42 0 0 1 62 100L40 100L40 156ZM40 37L62 37A21 21 0 0 1 62 79L40 79ZM217 56L217 156L195 156L195 148.47A52 52 0 1 1 195 63.53L195 56ZM165 75A30 31 0 1 0 165 137A30 31 0 1 0 165 75ZM234 56L256 56L256 63.53A52 52 0 1 1 256 148.47L256 206L234 206ZM286 75A30 31 0 1 0 286 137A30 31 0 1 0 286 75ZM426.81 148.61A52 52 0 1 1 448.03 116L368.6 116A30 31 0 0 0 411.4 133.2ZM368.02 98A30 31 0 0 1 425.98 98ZM461 156L461 56L483 56L483 63.53A52 52 0 0 1 527 55.92L527 78.58A30 31 0 0 0 483 106L483 156ZM540 156L540 16L612 16L632 36L564 36L564 78L596 78L616 98L564 98L564 156ZM676 54A52 52 0 1 1 676 158A52 52 0 1 1 676 54ZM676 75A30 31 0 1 0 676 137A30 31 0 1 0 676 75ZM740 156L740 56L762 56L762 63.53A52 52 0 0 1 806 55.92L806 78.58A30 31 0 0 0 762 106L762 156ZM917 56L917 162A44 44 0 0 1 873 206L847 206L825 184L873 184A22 22 0 0 0 895 162L895 148.47A52 52 0 1 1 895 63.53L895 56ZM865 75A30 31 0 1 0 865 137A30 31 0 1 0 865 75ZM1010.81 148.61A52 52 0 1 1 1032.03 116L952.6 116A30 31 0 0 0 995.4 133.2ZM952.02 98A30 31 0 0 1 1009.98 98Z'

export function BrandLockup() {
  return (
    <div role="img" aria-label="PaperForge" className="flex items-center gap-0.5">
      <svg width="24" height="24" viewBox="0 0 256 256" aria-hidden>
        <path d={SHEETS} fill="var(--pf-logo-sheet)" />
        <path d={PAGE} fill="var(--pf-logo-page)" />
      </svg>
      {/* The viewBox is centred on the capitals so the name lines up with the symbol, not with its descenders. */}
      <svg width="91" height="22" viewBox="16 -34 1017 240" aria-hidden>
        <path d={WORDMARK} fill="var(--pf-logo-sheet)" fillRule="evenodd" />
      </svg>
    </div>
  )
}
