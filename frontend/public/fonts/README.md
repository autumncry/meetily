Bundled local export fonts (SIL Open Font License 1.1; licenses alongside files):

- `NotoSansSC-Regular.ttf`: Noto Sans SC Regular, static `wght=400` instance from
  https://github.com/google/fonts/blob/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf
- `NotoEmoji-Regular.ttf`: Noto Emoji, static `wght=400` instance from
  https://github.com/google/fonts/blob/main/ofl/notoemoji/NotoEmoji%5Bwght%5D.ttf
  (emoji exports are monochrome).

Downloaded 2026-10-30. PDF embeds a CJK used-glyph subset and the complete emoji
font (the latter avoids invisible emoji in fontkit's subset output). DOCX embeds the complete
licensed font files and retains editable Unicode text. No runtime remote fetch.

Static instances generated with FontTools 4.60.2:
`fonttools varLib.instancer INPUT.ttf wght=400 --update-name-table --output OUTPUT.ttf`.
This is build-time preparation only; the app needs no Python/FontTools install.
