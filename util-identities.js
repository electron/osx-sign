/**
 * @module util-identities
 */

'use strict'

const Promise = require('bluebird')

const util = require('./util')
const debuglog = util.debuglog
const debugerror = util.debugerror
const flatList = util.flatList
const execFileAsync = util.execFileAsync

/**
 * This function returns a promise checking the indentity proposed and updates the identity option to a exact finding from results.
 * @function
 * @param {Object} opts - Options.
 * @param {string} identity - The proposed identity.
 * @returns {Promise} Promise.
 */
module.exports.findIdentitiesAsync = function (opts, identity) {
  // Only to look for valid identities, excluding those flagged with
  // CSSMERR_TP_CERT_EXPIRED or CSSMERR_TP_NOT_TRUSTED. Fixes #9

  var args = [
    'find-identity',
    '-v'
  ]
  if (opts.keychain) {
    args.push(opts.keychain)
  }

  return execFileAsync('security', args)
    .then(function (result) {
      return result.split('\n').map(function (line) {
        if (line.indexOf(identity) >= 0) {
          var identityFound = line.substring(line.indexOf('"') + 1, line.lastIndexOf('"'))
          debuglog('Identity:', '\n',
            '> Name:', identityFound)
          return identityFound
        }
        return undefined
      })
    })
    .then(flatList)
    .catch(function (err) {
      debugerror(err)
      return Promise.reject(new Error('Error in finding identities. See details in debug log. (electron-osx-sign:error)'))
    })
}
