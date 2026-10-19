
export {};

declare const __dirname: string;

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const desktopIcon = path.resolve(root, '..', 'Anywhere_desktop', 'build', 'icon.svg');
const mark = fs.readFileSync(path.join(root, 'src', 'components', 'DesktopBrandMark.tsx'), 'utf8');

function pngSize(file: string): [number, number] {
  const data = fs.readFileSync(file);
  if (data.toString('ascii', 1, 4) !== 'PNG') throw new Error(`not_png:${file}`);
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
}

describe('Android Desktop brand asset boundary', () => {
  it('renders the exact Desktop SVG geometry in the Mobile brand mark', () => {
    const source = fs.readFileSync(desktopIcon, 'utf8');
    for (const fragment of [
      '<rect x="20" y="40" width="120" height="80"/>',
      '<rect x="45" y="60" width="15" height="15"/>',
      '<rect x="70" y="85" width="20" height="8"/>',
    ]) expect(source).toContain(fragment);
    for (const fragment of [
      'x="20" y="40" width="120" height="80" fill="#000000"',
      'x="45" y="60" width="15" height="15" fill="#FFFFFF"',
      'x="70" y="85" width="20" height="8" fill="#FFFFFF"',
    ]) expect(mark).toContain(fragment);
  });

  it('uses Anywhere Mobile as the launcher display name in every Android variant', () => {
    const strings = fs.readFileSync(
      path.join(root, 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml'),
      'utf8',
    );
    const gradle = fs.readFileSync(path.join(root, 'android', 'app', 'build.gradle'), 'utf8');
    expect(strings).toContain('<string name="app_name">Anywhere Mobile</string>');
    expect(gradle).toContain('resValue "string", "app_name", "Anywhere Mobile"');
    expect(gradle).not.toContain('Anywhere Mobile 测试');
  });


  it('ships all Android launcher densities from the unified Desktop brand source', () => {
    for (const [density, size] of Object.entries({
      'mipmap-mdpi': 48,
      'mipmap-hdpi': 72,
      'mipmap-xhdpi': 96,
      'mipmap-xxhdpi': 144,
      'mipmap-xxxhdpi': 192,
    })) {
      const normal = path.join(root, 'android', 'app', 'src', 'main', 'res', density, 'ic_launcher.png');
      const round = path.join(root, 'android', 'app', 'src', 'main', 'res', density, 'ic_launcher_round.png');
      expect(pngSize(normal)).toEqual([size, size]);
      expect(pngSize(round)).toEqual([size, size]);
      expect(fs.readFileSync(normal).equals(fs.readFileSync(round))).toBe(true);
    }
  });
});
