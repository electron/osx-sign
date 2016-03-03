var fs = require('fs')
var path = require('path')
var child = require('child_process')

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
  child.exec([
    'security',
    'find-identity',
    '-v'
  ].join(' '), function (err, stdout, stderr) {
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

  // Call productbuild
  operations.push(function (cb) {
    child.exec([
      'productbuild',
      '--component', '"' + opts.app.replace(/"/g, '\\"') + '"', '"' + opts.install.replace(/"/g, '\\"') + '"',
      '--sign', '"' + opts.identity + '"',
      '"' + opts.pkg.replace(/"/g, '\\"') + '"'
    ].join(' '), function (err, stdout, stderr) {
      if (err) return cb(err)
      cb()
    })
    if (opts.verbose) console.log('Flattening with productbuild...')
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

function signApplication (opts, callback) {
  var operations = []
  var appContentsPath = generateAppContentsPath(opts)

  function isFileBinary (filePath) {
    var buf = fs.readFileSync(filePath)
    for (var i = 0, l = buf.length; i < l; i++) {
      if (buf[i] > 127) {
        return true
      }
    }
    return false
  }

  function walkSync (dirPath) {
    fs.readdirSync(dirPath).forEach(function (name) {
      var filePath = path.join(dirPath, name)
      var stat = fs.lstatSync(filePath)
      if (stat.isFile()) {
        switch (path.extname(filePath)) {
          case '': // binary
            if (path.basename(filePath)[0] === '.') break // reject hidden file
            if (!isFileBinary(filePath)) break // reject non-binary file
            childPaths.push(filePath)
            break
          case '.dylib': // dynamic library
            childPaths.push(filePath)
            break
          case '.cstemp': // temporary file generated from past codesign
            operations.push(function (cb) {
              fs.unlink(filePath, function (err) {
                if (err) return cb(err)
                cb()
              })
              console.log('Removing...', filePath)
            })
            break
          default:
            if (path.extname(filePath).includes(' ')) {
              // Still consider the file as binary if extension seems invalid
              if (!isFileBinary(filePath)) break // reject non-binary file
              childPaths.push(filePath)
            }
        }
      } else if (stat.isDirectory() && !stat.isSymbolicLink()) {
        switch (path.basename(filePath)) {
          case 'node_modules':
            break // ignore directory
        }
        walkSync(filePath)
        switch (path.extname(filePath)) {
          case '.app': // application
          case '.framework': // framework
            childPaths.push(filePath)
            break
        }
      }
    })
  }

  var childPaths = []
  walkSync(appContentsPath)
  if (opts.binaries) childPaths = childPaths.concat(opts.binaries)

  if (opts.entitlements) {
    // Sign with entitlements
    childPaths.forEach(function (filePath) {
      operations.push(function (cb) {
        child.exec([
          'codesign',
          '-s', '"' + opts.identity + '"',
          '-fv',
          '--entitlements', '"' + opts['entitlements-inherit'] + '"',
          '"' + filePath.replace(/"/g, '\\"') + '"'
        ].join(' '), function (err, stdout, stderr) {
          if (err) return cb(err)
          cb()
        })
        if (opts.verbose) console.log('Signing...', filePath)
      })
    })
    operations.push(function (cb) {
      child.exec([
        'codesign',
        '-s', '"' + opts.identity + '"',
        '-fv',
        '--entitlements', '"' + opts.entitlements + '"',
        '"' + opts.app.replace(/"/g, '\\"') + '"'
      ].join(' '), function (err, stdout, stderr) {
        if (err) return cb(err)
        cb()
      })
      if (opts.verbose) console.log('Signing...', opts.app)
    })
  } else {
    // Otherwise normally
    childPaths.forEach(function (filePath) {
      operations.push(function (cb) {
        child.exec([
          'codesign',
          '-s', '"' + opts.identity + '"',
          '-fv',
          '"' + filePath.replace(/"/g, '\\"') + '"'
        ].join(' '), function (err, stdout, stderr) {
          if (err) return cb(err)
          cb()
        })
        if (opts.verbose) console.log('Signing...', filePath)
      })
    })
    operations.push(function (cb) {
      child.exec([
        'codesign',
        '-s', '"' + opts.identity + '"',
        '-fv',
        '"' + opts.app.replace(/"/g, '\\"') + '"'
      ].join(' '), function (err, stdout, stderr) {
        if (err) return cb(err)
        cb()
      })
      if (opts.verbose) console.log('Signing...', opts.app)
    })
  }

  // Lastly verify codesign
  operations.push(function (cb) {
    child.exec([
      'codesign',
      '-v',
      '"' + opts.app.replace(/"/g, '\\"') + '"'
    ].join(' '), function (err, stdout, stderr) {
      if (err) return cb(err)
      cb()
    })
    if (opts.verbose) console.log('Verifying sign...')
  })
  if (opts.entitlements) {
    // Check entitlements
    operations.push(function (cb) {
      child.exec([
        'codesign',
        '-d',
        '--entitlements', '-',
        '"' + opts.app.replace(/"/g, '\\"') + '"'
      ].join(' '), function (err, stdout, stderr) {
        if (err) return cb(err)
        cb()
      })
      if (opts.verbose) console.log('Verifying entitlements...')
    })
  }

  series(operations, function (err) {
    if (err) return callback(err)
    callback()
  })
}

module.exports = function sign (opts, cb) {
  // Default callback function if none provided
  if (!cb) {
    cb = function (err) {
      if (err) {
        if (opts.verbose) {
          console.error('Sign failed.')
          if (err.message) console.error(err.message)
          else console.error(err, err.stack)
        }
        return
      }
      if (opts.verbose) console.log('Application signed:', opts.app)
    }
  }
  if (!opts.app) return cb(new Error('Path to aplication must be specified.'))
  if (path.extname(opts.app) !== '.app') return cb(new Error('Extension of application must be `.app`.'))
  if (!fs.existsSync(opts.app)) return cb(new Error('Application not found.'))
  // Match platform if none is provided
  if (!opts.platform) {
    if (opts.verbose) console.warn('No `platform` passed in arguments, checking Electron platform...')
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
      if (opts.verbose) console.warn('No `entitlements` passed in arguments, will fallback to default settings.')
      opts.entitlements = path.join(__dirname, 'default.mas.entitlements')
    }
    if (!opts['entitlements-inherit']) {
      if (opts.verbose) console.warn('No `entitlements-inherit` passed in arguments, will fallback to default settings.')
      opts['entitlements-inherit'] = path.join(__dirname, 'default.mas.inherit.entitlements')
    }
  } else if (opts.platform === 'darwin') {
    // Not necessary to have entitlements for non Mac App Store distribution
    if (!opts.entitlements) {
      if (opts.verbose) console.warn('No `entitlements` passed in arguments, will not sign with entitlements.')
    } else {
      // If entitlements is provided as a flag, fallback to default
      if (opts.entitlements === true) {
        if (opts.verbose) console.warn('`entitlements` not specified in arguments, will fallback to default settings.')
        opts.entitlements = path.join(__dirname, 'default.mas.entitlements')
      }
      if (!opts['entitlements-inherit']) {
        if (opts.verbose) console.warn('No `entitlements-inherit` passed in arguments, will fallback to default settings.')
        opts['entitlements-inherit'] = path.join(__dirname, 'default.darwin.inherit.entitlements')
      }
    }
  } else {
    return cb(new Error('Only platform `darwin` and `mas` are supported.'))
  }
  if (opts.binaries) {
    if (!Array.isArray(opts.binaries)) return cb(new Error('Additional binaries should be an Array.'))
  }
  series([
    function (cb) {
      // Checking identity with series for async execution of child process
      if (!opts.identity) {
        if (opts.verbose) console.warn('No `identity` passed in arguments, discovering identities...')
        if (opts.platform === 'mas') {
          findIdentity(opts, '3rd Party Mac Developer Application', cb)
        } else if (opts.platform === 'darwin') {
          findIdentity(opts, 'Developer ID Application', cb)
        }
      } else cb()
    }
  ], function (err) {
    if (err) return cb(err)
    if (opts.verbose) {
      console.log('Signing application...')
      console.log('> application        ', opts.app)
      console.log('> platform           ', opts.platform)
      console.log('> entitlements       ', opts.entitlements)
      console.log('> child-entitlements ', opts['entitlements-inherit'])
      console.log('> additional-binaries', opts.binaries)
      console.log('> identity           ', opts.identity)
    }
    return signApplication(opts, cb)
  })
}

module.exports.flat = function flat (opts, cb) {
  // Default callback function if none provided
  if (!cb) {
    cb = function (err) {
      if (err) {
        if (opts.verbose) {
          console.error('Flat failed.')
          if (err.message) console.error(err.message)
          else console.error(err, err.stack)
        }
        return
      }
      if (opts.verbose) console.log('Application flattened:', opts.pkg)
    }
  }
  if (!opts.app) return cb(new Error('Path to aplication must be specified.'))
  if (path.extname(opts.app) !== '.app') return cb(new Error('Extension of application must be `.app`.'))
  if (!fs.existsSync(opts.app)) return cb(new Error('Application not found.'))
  // Match platform if none is provided
  if (!opts.pkg) {
    if (opts.verbose) console.warn('No `pkg` passed in arguments, will fallback to default, inferred from the given application.')
    opts.pkg = path.join(path.dirname(opts.app), path.basename(opts.app, '.app') + '.pkg')
  } else if (path.extname(opts.pkg) !== '.pkg') return cb(new Error('Extension of output package must be `.pkg`.'))
  if (!opts.install) {
    if (opts.verbose) console.warn('No `install` passed in arguments, will fallback to default `/Applications`.')
    opts.install = '/Applications'
  }
  series([
    function (cb) {
      // Checking identity with series for async execution of child process
      if (!opts.identity) {
        if (opts.verbose) console.warn('No `identity` passed in arguments, discovering identities...')
        if (!opts.platform) {
          if (opts.verbose) console.warn('No `platform` passed in arguments, checking Electron platform...')
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
    if (opts.verbose) {
      console.log('Flattening application...')
      console.log('> application       ', opts.app)
      console.log('> package-output    ', opts.pkg)
      console.log('> install-path      ', opts.install)
      console.log('> identity          ', opts.identity)
    }
    return flatApplication(opts, cb)
  })
}
