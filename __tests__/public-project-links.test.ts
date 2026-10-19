export {};

declare const __dirname: string;

const fs = require('fs');
const path = require('path');

const mobileRoot = path.resolve(__dirname, '..');
const about = fs.readFileSync(
  path.join(mobileRoot, 'src', 'components', 'ManagementSettings.tsx'),
  'utf8',
);
const workspace = fs.readFileSync(
  path.join(mobileRoot, 'src', 'components', 'WorkspaceShell.tsx'),
  'utf8',
);

describe('public project links and compact Agent cards', () => {
  it('exposes both public repositories in the Mobile About page', () => {
    expect(about).toContain('https://github.com/Komorebi-yaodong/anywheredesktop');
    expect(about).toContain('https://github.com/Komorebi-yaodong/anywhere-mobile');
    expect(about).not.toContain('移动端仓库将在准备完成后发布');
  });

  it('keeps tool-only cards separated from their assistant identity', () => {
    expect(workspace).toContain("toolOnlyWrap: {alignSelf: 'stretch', maxWidth: '100%', gap: 7}");
    expect(workspace).toContain("!String(message.payload.reasoningContent || '').trim()");
  });


  it('lets two-column Agent cards contract to their actual content height', () => {
    const start = workspace.indexOf('assistantCard: {');
    const end = workspace.indexOf('  avatar:', start);
    const card = start >= 0 && end > start ? workspace.slice(start, end) : '';
    expect(card).toContain("width: '47%'");
    expect(card).not.toContain('minHeight: 162');
    expect(workspace).toContain("chipRow: { flexDirection: 'row', gap: 4, flexWrap: 'wrap' }");
  });
});
