/**
 * @module util-identities
 */

'use strict'

const { debuglog, execFileAsync } = require('./util')

/**
 * @constructor
 * @param {string} name - Name of the signing identity.
 * @param {String} hash - SHA-1 hash of the identity.
 */
const Identity = module.exports.Identity = function (name, hash) {
  this.name = name
  this.hash = hash
}

/**
 * This function returns a promise checking the indentity proposed and updates the identity option to a exact finding from results.
 * @function
 * @param {Object} opts - Options.
 * @param {string} identity - The proposed identity.
 * @returns {Promise} Promise.
 */
module.exports.findIdentitiesAsync = async function (opts, identity) {
  // Only to look for valid identities, excluding those flagged with
  // CSSMERR_TP_CERT_EXPIRED or CSSMERR_TP_NOT_TRUSTED. Fixes #9
  const args = [
    'find-identity',
    '-v'
  ]
  if (opts.keychain) {
    args.push(opts.keychain)
  }

  const identities = []
  for (const line of (await execFileAsync('security', args)).split('\n')) {
    if (line.includes(identity)) {
      const identityFound = line.substring(line.indexOf('"') + 1, line.lastIndexOf('"'))
      const identityHashFound = line.substring(line.indexOf(')') + 2, line.indexOf('"') - 1)
      debuglog('Identity:', '\n',
        '> Name:', identityFound, '\n',
        '> Hash:', identityHashFound)
      identities.push(new Identity(identityFound, identityHashFound))
    }
  }

  return identities
}
