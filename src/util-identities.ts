import { debugLog, compactFlattenedList, execFileAsync } from './util.js';

export class Identity {
  constructor(
    public name: string,
    public hash?: string,
  ) {}
}

export async function findIdentities(keychain: string | null, identity: string, validate: bool = true) {
  // An incoming identity string will be either a certificateName OR the identityHash for a certificate.
  // Certain edge-cases require us to have the identityHash to correctly invoke `codesign`.
  // Other flows require us to have the certificateName for automatic plist entitlement management done by osx-sign.
  // For those reasons, we always try to extrapolate the full certificateName & identityHash pair
  // More info here : https://github.com/electron/osx-sign/issues/452

  const args = ['find-identity'];
  if(validate){
    // Only to look for valid identities, excluding those flagged with
    // CSSMERR_TP_CERT_EXPIRED or CSSMERR_TP_NOT_TRUSTED. Fixes #9
    args.push('-v');
  }
  if (keychain) {
    args.push(keychain);
  }

  const result = await execFileAsync('security', args);
  // When running with validate=false. All valid identities will appear in results twice. Set() on unique hash is used here to prevent duplicates stacking up
  const seen: Set<string> = new Set();

  const identities = result.split('\n').map(function (line) {
    if (line.indexOf(identity) >= 0) {
      const identityFound = line.substring(line.indexOf('"') + 1, line.lastIndexOf('"'));
      const identityHashFound = line.substring(line.indexOf(')') + 2, line.indexOf('"') - 1);
      if (seen.has(identityHashFound)) {
        return null; // duplicate
      }
      seen.add(identityHashFound);
      debugLog('Identity:', '\n', '> Name:', identityFound, '\n', '> Hash:', identityHashFound);
      return new Identity(identityFound, identityHashFound);
    }

    return null;
  });

  if(identities.length==0 && !validate){
    debugLog('Failed to look up full identity-hash & certificate-name pair, using input identity as-is:', identity, err);
    identities.push(new Identitity(identity))
  }

  return compactFlattenedList(identities);
}
