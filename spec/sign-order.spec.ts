import { describe, expect, it } from 'vitest';

import { isBundleMainExecutable, signingRank, sortForSigning } from '../src/sign.js';

const APP = '/build/Foo.app';
const contents = (rel: string) => `${APP}/Contents/${rel}`;

const main = contents('MacOS/Foo');
const flatHelper = contents('Helpers/helper');
const framework = contents('Frameworks/Foo.framework');
const frameworkBinary = `${framework}/Versions/A/Foo`;
const helperApp = contents('Frameworks/Foo Helper.app');
const helperAppMain = `${helperApp}/Contents/MacOS/Foo Helper`;
const helperAppTool = `${helperApp}/Contents/Helpers/tool`;

describe('isBundleMainExecutable', () => {
  it.each([main, helperAppMain, contents('MacOS/some-other-tool')])('matches %s', (filePath) => {
    expect(isBundleMainExecutable(filePath)).toBe(true);
  });

  it.each([
    APP,
    flatHelper,
    framework,
    frameworkBinary,
    `${framework}/Versions/A/Helpers/chrome_crashpad_handler`,
    helperApp,
    helperAppTool,
    contents('MacOS/nested/not-a-main-executable'),
    contents('Resources/MacOS/decoy'),
  ])('does not match %s', (filePath) => {
    expect(isBundleMainExecutable(filePath)).toBe(false);
  });
});

describe('signingRank', () => {
  it('ranks deeper files ahead of shallower ones', () => {
    expect(signingRank(frameworkBinary)).toBeGreaterThan(signingRank(framework));
    expect(signingRank(flatHelper)).toBeGreaterThan(signingRank(APP));
  });

  it('ranks a main executable behind its same-depth siblings, but ahead of shallower files', () => {
    expect(signingRank(flatHelper)).toBeGreaterThan(signingRank(main));
    expect(signingRank(framework)).toBeGreaterThan(signingRank(main));
    expect(signingRank(helperAppTool)).toBeGreaterThan(signingRank(helperAppMain));
    expect(signingRank(main)).toBeGreaterThan(signingRank(APP));
  });

  it('ranks same-depth non-main files equally', () => {
    expect(signingRank(contents('Helpers/a'))).toBe(signingRank(contents('PlugIns/b')));
  });
});

describe('sortForSigning', () => {
  it('signs a bundle main executable after the same-depth nested code it seals', () => {
    // Discovery order deliberately lists MacOS/ before Helpers/: ordering by depth alone
    // would sign the main executable (which seals the bundle) while the helper is still
    // unsigned.
    expect(sortForSigning([main, flatHelper])).toEqual([flatHelper, main]);
    expect(sortForSigning([helperAppMain, helperAppTool])).toEqual([helperAppTool, helperAppMain]);
  });

  it('otherwise signs from the inside out', () => {
    expect(
      sortForSigning([APP, framework, main, flatHelper, helperAppMain, frameworkBinary]),
    ).toEqual([frameworkBinary, helperAppMain, framework, flatHelper, main, APP]);
  });

  it('is stable within a rank and does not mutate its input', () => {
    const input = [contents('Helpers/b'), contents('Helpers/a'), contents('PlugIns/c')];
    const snapshot = [...input];
    expect(sortForSigning(input)).toEqual(snapshot);
    expect(input).toEqual(snapshot);
  });
});
