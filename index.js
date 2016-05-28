'use strict'

var fs = require('fs')
var path = require('path')
var child = require('child_process')
var Promise = require('bluebird')
var debug = require('debug')
var debuglog = debug('electron-osx-sign')
debuglog.log = console.log.bind(console)
var debugwarn = debug('electron-osx-sign:warn')
debugwarn.log = console.warn.bind(console)
var debugerror = debug('electron-osx-sign:error')
debugerror.log = console.error.bind(console)
var isBinaryFile = Promise.promisify(require('isbinaryfile'))

var series = require('run-series')

function detectElectronPlatform (opts) {
  var appFrameworksPath = generateAppFrameworksPath(opts)
  if (!fs.existsSync(path.join(appFrameworksPath, 'Squirrel.framework'))) {
    // The presence of Squirrel.framework identifies a Mac App Store build as
    // used in https://github.com/atom/electron/blob/master/docs/tutorial/mac-app-store-submission-guide.md
    opts.platform = 'mas'
  } else {
    opts.platform = 'darwin'
  }
}

function findIdentity (opts, identity, cb) {
  // Only to look for valid identities, excluding those flagged with
  // CSSMERR_TP_CERT_EXPIRED or CSSMERR_TP_NOT_TRUSTED. Fix #9

  var args = [
    'find-identity',
    '-v'
  ]
  if (opts.keychain) {
    args.push(opts.keychain)
  }

  child.execFile('security', args, function (err, stdout, stderr) {
    if (err) return cb(new Error('Error in finding an identity.'))
    var lines = stdout.split('\n')
    var location
    for (var i = 0, l = lines.length; i < l; i++) {
      var line = lines[i]
      location = line.indexOf(identity)
      if (location >= 0) {
        opts.identity = line.substring(location, line.lastIndexOf('"'))
        break
      }
    }
    if (!opts.identity) cb(new Error('No identity found for signing.'))
    cb()
  })
}

function flatApplication (opts, callback) {
  var operations = []

  var args = [
    '--component', opts.app, opts.install,
    '--sign', opts.identity,
    opts.pkg
  ]
  if (opts.keychain) {
    args.unshift('--keychain', opts.keychain)
  }

  // Call productbuild
  operations.push(function (cb) {
    child.execFile('productbuild', args, function (err, stdout, stderr) {
      if (err) return cb(err)
      cb()
    })
    debuglog('Flattening with productbuild...')
  })

  series(operations, function (err) {
    if (err) return callback(err)
    callback()
  })
}

function generateAppContentsPath (opts) {
  return path.join(opts.app, 'Contents')
}

function generateAppFrameworksPath (opts) {
  return path.join(generateAppContentsPath(opts), 'Frameworks')
}

function signApplication (opts) {
  var unlink = Promise.promisify(fs.unlink)
  var readdir = Promise.promisify(fs.readdir)
  var lstat = Promise.promisify(fs.lstat)

  function getPathIfBinary (filePath) {
    return isBinaryFile(filePath)
      .then(function (isBinary) {
        return isBinary ? filePath : null
      })
  }

  function walk (dirPath) {
    return readdir(dirPath)
      .then(function (result) {
        return Promise.map(result, function (name) {
          var filePath = path.join(dirPath, name)
          return lstat(filePath)
            .then(function (stat) {
              if (stat.isFile()) {
                switch (path.extname(filePath)) {
                  case '': // binary
                    // reject hidden file
                    if (path.basename(filePath)[0] !== '.') {
                      return getPathIfBinary(filePath)
                    }
                    break
                  case '.dylib': // dynamic library
                  case '.node': // native node addon
                    return filePath
                  case '.cstemp': // temporary file generated from past codesign
                    debuglog('Removing... ' + filePath)
                    return unlink(filePath)
                      .thenReturn(null)
                  default:
                    if (path.extname(filePath).indexOf(' ') > -1) {
                      // Still consider the file as binary if extension seems invalid
                      return getPathIfBinary(filePath)
                    }
                }
              } else if (stat.isDirectory() && !stat.isSymbolicLink()) {
                return walk(filePath)
                  .then(function (result) {
                    switch (path.extname(filePath)) {
                      case '.app': // application
                      case '.framework': // framework
                        result.push(filePath)
                        break
                    }
                    return result
                  })
              }

              return null
            })
        })
      })
  }

  return walk(generateAppContentsPath(opts))
    .then(function (result) {
      var flatResult = []

      function addFlat (list) {
        if (!Array.isArray(list)) {
          flatResult.push(list)
        } else if (list.length > 0) {
          for (let item of list) {
            if (item != null) {
              addFlat(item)
            }
          }
        }
      }

      addFlat(result)
      return signFiles(opts, opts.binaries ? flatResult.concat(opts.binaries) : flatResult)
    })
}

function signFiles (opts, childPaths) {
  var args = [
    '--sign', opts.identity,
    '-fv'
  ]
  if (opts.keychain) {
    args.push('--keychain', opts.keychain)
  }

  var execFile = Promise.promisify(child.execFile)
  var promise
  if (opts.entitlements) {
    // Sign with entitlements
    promise = Promise.mapSeries(childPaths, function (filePath) {
      debuglog('Signing... ' + filePath)
      return execFile('codesign', args.concat('--entitlements', opts['entitlements-inherit'], filePath))
    })
      .then(function () {
        debuglog('Signing... ' + opts.app)
        execFile('codesign', args.concat('--entitlements', opts.entitlements, opts.app))
      })
  } else {
    // Otherwise normally
    promise = Promise.mapSeries(childPaths, function (filePath) {
      debuglog('Signing... ' + filePath)
      return execFile('codesign', args.concat(filePath))
    })
      .then(function () {
        debuglog('Signing... ' + opts.app)
        return execFile('codesign', args.concat(opts.app))
      })
  }

  // Lastly verify codesign
  return promise
    .then(function () {
      debuglog('Verifying sign...')
      var promise = execFile('codesign', ['-v', opts.app])
      if (opts.entitlements) {
        // Check entitlements
        promise
          .then(function () {
            debuglog('Verifying entitlements...')
            return Promise.all([promise, execFile('codesign', ['-d', '--entitlements', '-', opts.app])])
          })
      } else {
        return promise
      }
    })
}

function sign (opts, cb) {
  // Default callback function if none provided
  if (!cb) {
    cb = function (err) {
      if (err) {
        debugerror('Sign failed.')
        if (err.message) debugerror(err.message)
        else debugerror(err.stack)
        return
      }
      debuglog('Application signed: ' + opts.app)
    }
  }
  if (!opts.app) return cb(new Error('Path to aplication must be specified.'))
  if (path.extname(opts.app) !== '.app') return cb(new Error('Extension of application must be `.app`.'))
  if (!fs.existsSync(opts.app)) return cb(new Error('Application not found.'))
  // Match platform if none is provided
  if (!opts.platform) {
    debugwarn('No `platform` passed in arguments, checking Electron platform...')
    detectElectronPlatform(opts)
  }
  if (opts.platform === 'mas') {
    // To sign apps for Mac App Store, an entitlements file is required,
    // especially for app sandboxing (as well some other services).
    // Fallback entitlements for sandboxing by default:
    // Note this may cause troubles while running an signed app due to
    // missing keys special to the project.
    // Further reading: https://developer.apple.com/library/mac/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html
    if (!opts.entitlements) {
      debugwarn('No `entitlements` passed in arguments, will fallback to default settings.')
      opts.entitlements = path.join(__dirname, 'default.mas.entitlements')
    }
    if (!opts['entitlements-inherit']) {
      debugwarn('No `entitlements-inherit` passed in arguments, will fallback to default settings.')
      opts['entitlements-inherit'] = path.join(__dirname, 'default.mas.inherit.entitlements')
    }
  } else if (opts.platform === 'darwin') {
    // Not necessary to have entitlements for non Mac App Store distribution
    if (!opts.entitlements) {
      debugwarn('No `entitlements` passed in arguments, will not sign with entitlements.')
    } else {
      // If entitlements is provided as a flag, fallback to default
      if (opts.entitlements === true) {
        debugwarn('`entitlements` not specified in arguments, will fallback to default settings.')
        opts.entitlements = path.join(__dirname, 'default.darwin.entitlements')
      }
      if (!opts['entitlements-inherit']) {
        debugwarn('No `entitlements-inherit` passed in arguments, will fallback to default settings.')
        opts['entitlements-inherit'] = path.join(__dirname, 'default.darwin.inherit.entitlements')
      }
    }
  } else {
    return cb(new Error('Only platform `darwin` and `mas` are supported.'))
  }
  if (opts.binaries) {
    if (!Array.isArray(opts.binaries)) return cb(new Error('Additional binaries should be an Array.'))
  }
  if (opts.ignore) {
    if (typeof opts.ignore !== 'function' || typeof opts.ignore !== 'string') return cb(new Error('Ignore filter should be either a function or a string.'))
  }
  series([
    function (cb) {
      // Checking identity with series for async execution of child process
      if (!opts.identity) {
        debugwarn('No `identity` passed in arguments, discovering identities...')
        if (opts.platform === 'mas') {
          findIdentity(opts, '3rd Party Mac Developer Application', cb)
        } else if (opts.platform === 'darwin') {
          findIdentity(opts, 'Developer ID Application', cb)
        }
      } else cb()
    }
  ], function (err) {
    if (err) return cb(err)
    debuglog('Signing application...')
    debuglog('> application         ' + opts.app)
    debuglog('> platform            ' + opts.platform)
    debuglog('> entitlements        ' + opts.entitlements)
    debuglog('> child-entitlements  ' + opts['entitlements-inherit'])
    debuglog('> additional-binaries ' + opts.binaries)
    debuglog('> identity            ' + opts.identity)
    signApplication(opts)
      .then(function () {
        cb()
      })
      .catch(cb)
  })
}

function flat (opts, cb) {
  // Default callback function if none provided
  if (!cb) {
    cb = function (err) {
      if (err) {
        debugerror('Flat failed.')
        if (err.message) debugerror(err.message)
        else debugerror(err.stack)
        return
      }
      debuglog('Application flattened: ' + opts.pkg)
    }
  }
  if (!opts.app) return cb(new Error('Path to aplication must be specified.'))
  if (path.extname(opts.app) !== '.app') return cb(new Error('Extension of application must be `.app`.'))
  if (!fs.existsSync(opts.app)) return cb(new Error('Application not found.'))
  // Match platform if none is provided
  if (!opts.pkg) {
    debugwarn('No `pkg` passed in arguments, will fallback to default, inferred from the given application.')
    opts.pkg = path.join(path.dirname(opts.app), path.basename(opts.app, '.app') + '.pkg')
  } else if (path.extname(opts.pkg) !== '.pkg') return cb(new Error('Extension of output package must be `.pkg`.'))
  if (!opts.install) {
    debugwarn('No `install` passed in arguments, will fallback to default `/Applications`.')
    opts.install = '/Applications'
  }
  series([
    function (cb) {
      // Checking identity with series for async execution of child process
      if (!opts.identity) {
        debugwarn('No `identity` passed in arguments, discovering identities...')
        if (!opts.platform) {
          debugwarn('No `platform` passed in arguments, checking Electron platform...')
          detectElectronPlatform(opts)
        } else if (opts.platform !== 'mas' && opts.platform !== 'darwin') {
          return cb(new Error('Only platform `darwin` and `mas` are supported.'))
        }
        if (opts.platform === 'mas') {
          findIdentity(opts, '3rd Party Mac Developer Installer', cb)
        } else if (opts.platform === 'darwin') {
          findIdentity(opts, 'Developer ID Installer', cb)
        }
      } else cb()
    }
  ], function (err) {
    if (err) return cb(err)
    debuglog('Flattening application...')
    debuglog('> application    ' + opts.app)
    debuglog('> package-output ' + opts.pkg)
    debuglog('> install-path   ' + opts.install)
    debuglog('> identity       ' + opts.identity)
    return flatApplication(opts, cb)
  })
}

module.exports = sign
module.exports.sign = sign
module.exports.flat = flat
