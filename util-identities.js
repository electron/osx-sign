/**
 * @module util-identities
 */

'use strict'

const util = require('./util')
const debuglog = util.debuglog
const flatList = util.flatList
const execFileAsync = util.execFileAsync

/**
 * @constructor
 * @param {string} name - Name of the signing identity.
 * @param {String} hash - SHA-1 hash of the identity.
 */
var Identity = module.exports.Identity = function (name, hash) {
  this.name = name
  this.hash = hash
}

/**
 * This function returns a promise of a list of matching indentities.
 * @function
 * @param {Object} opts - Options.
 * @param {(string|string[])} identities - A proposed identity or a list of identities ordered by priority.
 * @returns {Promise} Promise.
 */
module.exports.findIdentitiesAsync = function (opts, identities) {
  // Only to look for valid identities, excluding those flagged with
  // CSSMERR_TP_CERT_EXPIRED or CSSMERR_TP_NOT_TRUSTED. Fixes #9

  if (!Array.isArray(identities)) {
    identities = [identities]
  }

  var args = [
    'find-identity',
    '-v'
  ]
  if (opts.keychain) {
    args.push(opts.keychain)
  }

  return execFileAsync('security', args)
    .then(function (result) {
      var resultLines = result.split('\n')
      return identities.map(function (identity) {
        return resultLines.map(function (line) {
          if (line.indexOf(identity) >= 0) {
            var identityFound = line.substring(line.indexOf('"') + 1, line.lastIndexOf('"'))
            var identityHashFound = line.substring(line.indexOf(')') + 2, line.indexOf('"') - 1)
            debuglog('Identity:', '\n',
              '> Name:', identityFound, '\n',
              '> Hash:', identityHashFound)
            return new Identity(identityFound, identityHashFound)
          }
        })
      })
    })
    .then(flatList)
}
