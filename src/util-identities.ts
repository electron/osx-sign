import { debugLog, compactFlattenedList, execFileAsync } from './util.js';

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

/**
 * Resolves the identity to sign with when `identityValidation` is `false`.
 *
 * The caller's `identity` is normally used as-is. When it is a certificate SHA-1 hash,
 * though, the certificate's name (and the team ID that `preAutoEntitlements` parses
 * out of it) would be unknown, so look the hash up. This is best effort: if the lookup
 * fails or finds nothing, fall back to the raw value so that disabling validation never
 * makes signing fail on its own.
 */
export async function resolveUnvalidatedIdentity(
  keychain: string | null,
  identity: string,
): Promise<Identity> {
  if (/^[0-9a-f]{40}$/i.test(identity)) {
    const hash = identity.toUpperCase();
    try {
      // A SHA-1 hash names exactly one certificate; it can still be listed more than once
      // (e.g. when it is in several keychains), so any exact match will do.
      const match = (await findIdentities(keychain, hash)).find(
        (found) => found.hash?.toUpperCase() === hash,
      );
      if (match) return match;
      debugLog('No identity found for hash, using it as-is:', identity);
    } catch (err) {
      debugLog('Failed to look up identity hash, using it as-is:', identity, err);
    }
  }
  return new Identity(identity);
}
