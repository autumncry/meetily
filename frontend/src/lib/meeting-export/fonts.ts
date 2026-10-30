export interface ExportFonts { cjk: Uint8Array; emoji: Uint8Array; hanFallback?: Uint8Array }
let bundledFonts: Promise<ExportFonts> | undefined;

/** Assets ship inside the app's static frontend; never requests a remote font. */
export async function loadExportFonts(): Promise<ExportFonts> {
  if (!bundledFonts) {
    bundledFonts = Promise.all(['NotoSansSC-Regular.ttf', 'NotoEmoji-Regular.ttf', 'NotoSansJP-Regular.ttf'].map(async filename => {
      const response = await fetch(`/fonts/${filename}`);
      if (!response.ok) throw new Error(`Could not load bundled export font (${filename}).`);
      return new Uint8Array(await response.arrayBuffer());
    })).then(([cjk, emoji, hanFallback]) => ({ cjk, emoji, hanFallback })).catch(error => {
      bundledFonts = undefined;
      throw error;
    });
  }
  return bundledFonts;
}
