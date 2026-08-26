# Viewer design-token contract

`@takazudo/zudo-history-stash-ui` consumes the tokens in this document. Hosts define these names before loading the package stylesheet; the Viewer definition in `workers/viewer/src/styles/tokens.css` is the reference implementation.

This list is frozen. A token may be added compatibly, but renaming or removing one requires a coordinated package change. Palette tokens (`--palette-*`) are intentionally private: package CSS consumes semantic or component roles, never raw palette values.

## Theme activation

Dark is the no-preference default. Set `data-theme="light"` or `data-theme="dark"` on the root element for an explicit scheme. `data-theme="system"` follows `prefers-color-scheme`. The Viewer persists that three-state choice under `zhs.theme` and applies it before styles paint.

## Semantic color and effect roles

- Canvas and surfaces: `--theme-canvas`, `--theme-surface`, `--theme-surface-raised`, `--theme-surface-muted`
- Text: `--theme-ink`, `--theme-ink-strong`, `--theme-ink-muted`
- Borders: `--theme-border`, `--theme-border-strong`
- Accent: `--theme-accent`, `--theme-accent-subtle`, `--theme-accent-soft`, `--theme-on-accent`
- Interaction: `--theme-focus`, `--theme-hover-bg`, `--theme-hover-fg`, `--theme-active-bg`, `--theme-active-fg`, `--theme-selection`, `--theme-transparent`
- Status: `--theme-success`, `--theme-success-soft`, `--theme-error`, `--theme-error-soft`, `--theme-info`, `--theme-info-soft`, `--theme-warning`, `--theme-warning-soft`
- Diff additions: `--theme-diff-add-bg`, `--theme-diff-add-fg`, `--theme-diff-add-mark`
- Diff removals: `--theme-diff-remove-bg`, `--theme-diff-remove-fg`, `--theme-diff-remove-mark`
- Diff context: `--theme-diff-context-bg`, `--theme-diff-context-fg`
- Dialog effects: `--overlay-bg`, `--shadow-dialog`

The diff `bg` roles are the row washes; the `mark` roles are the stronger intraline marks. Dialog scrims and shadows must use the two dialog-effect roles rather than locally composed colors.

## Component roles

- Header: `--header-bg`, `--header-border`
- Primary button: `--button-primary-bg`, `--button-primary-fg`, `--button-primary-hover-bg`, `--button-primary-hover-fg`
- Secondary button: `--button-secondary-bg`, `--button-secondary-fg`, `--button-secondary-hover-bg`, `--button-secondary-hover-fg`
- Danger button: `--button-danger-bg`, `--button-danger-fg`, `--button-danger-hover-bg`, `--button-danger-hover-fg`
- Pressed button: `--button-active-bg`, `--button-active-fg`
- Table header and rows: `--table-header-bg`, `--table-row-bg`, `--table-row-hover-bg`, `--table-row-hover-fg`, `--table-row-active-bg`, `--table-row-active-fg`, `--table-row-active-border`
- Badge: `--badge-bg`, `--badge-fg`
- Form controls: `--input-bg`, `--input-border`

Component roles point to semantic roles. Package CSS may consume either layer when a component-specific alias would not add meaning; it must not consume `--palette-*`.

## Typography

- Families: `--font-sans`, `--font-family-mono`
- Sizes: `--text-xs`, `--text-sm`, `--text-md`, `--text-lg`, `--text-xl`
- Line heights: `--line-tight`, `--line-body`, `--line-code`

The reference size ladder is 13 / 14 / 15 / 18 / 22 CSS pixels expressed as `rem`. The sans stack is deliberately the product-specified Japanese-first system stack; no webfont is loaded by the contract.

## Spacing and density

- Frozen scale (4 / 6 / 8 / 12 / 16 / 20 / 24 / 32 CSS pixels): `--space-xs`, `--space-sm`, `--space-md`, `--space-lg`, `--space-xl`, `--space-2xl`, `--space-3xl`, `--space-4xl`
- Horizontal roles: `--hsp-xs`, `--hsp-sm`, `--hsp-md`, `--hsp-lg`, `--hsp-xl`
- Vertical roles: `--vsp-xs`, `--vsp-sm`, `--vsp-md`, `--vsp-lg`, `--vsp-xl`
- Dense geometry: `--row-dense`, `--control-height`

Both dense geometry roles resolve to 28 CSS pixels. Package components use the directional roles for padding and gaps, and use the base scale only when no directional role fits.

## Shape and hairlines

- Radius: `--radius-sm`, `--radius-md`
- Lines: `--border-hairline`, `--active-indicator-width`

Both radius roles resolve to zero. `--border-hairline` stays a crisp one-CSS-pixel line; `--active-indicator-width` reserves the two-CSS-pixel selection bar so row text does not move when selection changes.
