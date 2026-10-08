# SELECT — Brand assets

| Arquivo | Uso |
|---|---|
| `select-icon.svg` | Avatar (Discord, X, GitHub org), app icon — fundo obsidian |
| `select-favicon.svg` / `favicon.ico` | Favicon (≤ 48 px), versão simplificada |
| `select-mark-{gold,white,black}.svg` | Símbolo transparente |
| `select-logo-horizontal.svg` | Lockup para fundo escuro |
| `select-logo-horizontal-light.svg` | Lockup para fundo claro |
| `select-logo-horizontal-{white,black}.svg` | Monocromático |
| `png/` | PNGs 16–2048 px, apple-touch-icon 180 px |
| `preview.html` | Prévia + exportação PNG no navegador |

README do GitHub com tema automático:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/branding/select-logo-horizontal.svg">
  <img alt="SELECT" src="assets/branding/select-logo-horizontal-light.svg" width="420">
</picture>
```

Cores: Obsidian `#0A0D14` · Imperial Gold `#D4AF37` (em fundo claro `#A8842A`) · Platina `#F4F4F6`.
Geometria: diâmetro do anel dos louros = (altura do S + traço) × φ. Sem fontes externas: todo o texto é geometria.
