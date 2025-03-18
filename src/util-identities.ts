import { debugLog, compactFlattenedList, execFileAsync } from './util';

export class Identity {
  constructor(
    public name: string,
    public hash?: string,
  ) {}
}

export async function findIdentities(keychain: string | null, identity: string) {
  // Only to look for valid identities, excluding those flagged with
  // CSSMERR_TP_CERT_EXPIRED or CSSMERR_TP_NOT_TRUSTED. Fixes #9

  const args = ['find-identity', '-v'];
  if (keychain) {
    args.push(keychain);
  }

  const result = await execFileAsync('security', args);
  const identities = result.split('\n').map(function (line) {
    if (line.indexOf(identity) >= 0) {
      const identityFound = line.substring(line.indexOf('"') + 1, line.lastIndexOf('"'));
      const identityHashFound = line.substring(line.indexOf(')') + 2, line.indexOf('"') - 1);
      debugLog('Identity:', '\n', '> Name:', identityFound, '\n', '> Hash:', identityHashFound);
      return new Identity(identityFound, identityHashFound);
    }

    return null;
  });

  return compactFlattenedList(identities);
}
