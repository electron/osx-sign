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
  child.exec('security find-identity', function (err, stdout, stderr) {
    if (err) return cb(new Error('Error in finding an identity.'))
    var lines = stdout.split('\n')
    var location
    for (var i = 0, l = lines.length; i < l && !opts.identity; i++) {
      var line = lines[i]
      location = line.indexOf(identity)
      if (location >= 0) {
        opts.identity = line.substring(location, line.length - 1)
        break
      }
    }
    if (!opts.identity) cb(new Error('No identity found for signing.'))
    cb()
  })
}

function generateAppBasename (opts) {
  return path.basename(opts.app, '.app')
}

function generateAppFrameworksPath (opts) {
  return path.join(opts.app, 'Contents', 'Frameworks')
}

function generateHelperAppPath (opts, opt, suffix, callback) {
  if (opts[opt]) {
    // Use helper path if specified
    if (fs.existsSync(opts[opt])) return opts[opt]
    else return callback(new Error('Specified Electron Helper not found.'))
  } else {
    var appFrameworksPath = generateAppFrameworksPath(opts)
    var appBasename = generateAppBasename(opts)
    var helperPath
    if (fs.existsSync(helperPath = path.join(appFrameworksPath, appBasename + ' Helper' + (suffix || '') + '.app'))) {
      // Try to look for helper named after app (assume renamed)
      return helperPath
    } else if (fs.existsSync(helperPath = path.join(appFrameworksPath,
        'Electron Helper' + (suffix || '') + '.app'))) {
      // Try to look for helper by default
      return helperPath
    } else {
      // Helper not found
      callback(new Error('Electron Helper' + (suffix || '') + ' not found.'))
      return null
    }
  }
}

function generateHelperAppExecutablePath (opts, opt, helperPath, suffix, callback) {
  if (opts[opt]) {
    // Use helper executable path if specified
    if (fs.existsSync(opts[opt])) return opts[opt]
    else return callback(new Error('Specified Electron Helper executable not found.'))
  } else {
    var appBasename = generateAppBasename(opts)
    var helperExecutablePath
    if (fs.existsSync(helperExecutablePath = path.join(helperPath, 'Contents', 'MacOS', appBasename + ' Helper' + (suffix || '')))) {
      // Try to look for helper named after app (assume renamed)
      return helperExecutablePath
    } else if (fs.existsSync(helperExecutablePath = path.join(helperPath, 'Contents', 'MacOS', 'Electron Helper' + (suffix || '')))) {
      // Try to look for helper by default
      return helperExecutablePath
    } else {
      // Helper not found
      callback(new Error('Electron Helper' + (suffix || '') + ' executable not found.'))
      return null
    }
  }
}

function signApplication (opts, callback) {
  var operations = []
  var appFrameworksPath = generateAppFrameworksPath(opts)

  var childPaths
  if (opts.platform === 'mas') {
    childPaths = [
      path.join(appFrameworksPath, 'Electron Framework.framework', 'Libraries', 'libnode.dylib'),
      path.join(appFrameworksPath, 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework'),
      path.join(appFrameworksPath, 'Electron Framework.framework')
    ]
  } else if (opts.platform === 'darwin') {
    childPaths = [
      path.join(appFrameworksPath, 'Electron Framework.framework', 'Libraries', 'libnode.dylib'),
      path.join(appFrameworksPath, 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework'),
      path.join(appFrameworksPath, 'Electron Framework.framework'),
      path.join(appFrameworksPath, 'Mantle.framework', 'Versions', 'A', 'Mantle'),
      path.join(appFrameworksPath, 'Mantle.framework'),
      path.join(appFrameworksPath, 'ReactiveCocoa.framework', 'Versions', 'A', 'ReactiveCocoa'),
      path.join(appFrameworksPath, 'ReactiveCocoa.framework'),
      path.join(appFrameworksPath, 'Squirrel.framework', 'Versions', 'A', 'Squirrel'),
      path.join(appFrameworksPath, 'Squirrel.framework')
    ]
  }
  if (opts.binaries) childPaths.concat(opts.binaries)

  var helperPath = generateHelperAppPath(opts, 'helper-path', null, callback)
  if (helperPath) {
    var helperExecutablePath = generateHelperAppExecutablePath(opts, 'helper-executable-path', helperPath, null, callback)
    if (helperExecutablePath) childPaths.unshift(helperExecutablePath, helperPath)
    else return callback(new Error('Missing Electron Helper, stopped.'))
  }

  var helperEHPath = generateHelperAppPath(opts, 'helper-eh-path', ' EH', callback)
  if (helperEHPath) {
    var helperEHExecutablePath = generateHelperAppExecutablePath(opts, 'helper-eh-executable-path', helperEHPath, ' EH', callback)
    if (helperEHExecutablePath) childPaths.unshift(helperEHExecutablePath, helperEHPath)
    else return callback(new Error('Missing Electron Helper EH, stopped.'))
  }

  var helperNPPath = generateHelperAppPath(opts, 'helper-np-path', ' NP', callback)
  if (helperNPPath) {
    var helperNPExecutablePath = generateHelperAppExecutablePath(opts, 'helper-np-executable-path', helperNPPath, ' NP', callback)
    if (helperNPExecutablePath) childPaths.unshift(helperNPExecutablePath, helperNPPath)
    else return callback(new Error('Missing Electron Helper NP, stopped.'))
  }

  if (opts.entitlements) {
    if (opts.platform === 'mas') {
      // Sign with entitlements
      childPaths.forEach(function (path) {
        operations.push(function (cb) {
          child.exec([
            'codesign',
            '-s', '"' + opts.identity + '"',
            '-fv',
            '--entitlements', '"' + opts['entitlements-inherit'] + '"',
            '"' + path.replace(/"/g, '\\"') + '"'
          ].join(' '), cb)
          if (opts.verbose) console.log('Signing...', path)
        })
      })
      operations.push(function (cb) {
        child.exec([
          'codesign',
          '-s', '"' + opts.identity + '"',
          '-fv',
          '--entitlements', '"' + opts.entitlements + '"',
          '"' + opts.app.replace(/"/g, '\\"') + '"'
        ].join(' '), cb)
        if (opts.verbose) console.log('Signing...', opts.app)
      })
    } else if (opts.platform === 'darwin') {
      // TODO: Signing darwin builds with entitlements
    }
  } else {
    // Otherwise normally
    childPaths.forEach(function (path) {
      operations.push(function (cb) {
        child.exec([
          'codesign',
          '-s', '"' + opts.identity + '"',
          '-fv',
          '"' + path.replace(/"/g, '\\"') + '"'
        ].join(' '), cb)
        if (opts.verbose) console.log('Signing...', path)
      })
    })
    operations.push(function (cb) {
      child.exec([
        'codesign',
        '-s', '"' + opts.identity + '"',
        '-fv',
        '"' + opts.app.replace(/"/g, '\\"') + '"'
      ].join(' '), cb)
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
    if (opts.verbose) console.warn('No `--platform` passed in arguments, cheking Electron platform...')
    detectElectronPlatform(opts)
  } else if (opts.platform === 'mas') {
    // To sign apps for Mac App Store, an entitlements file is required,
    // especially for app sandboxing (as well some other services).
    // Fallback entitlements for sandboxing by default:
    // Note this may cause troubles while running an signed app due to
    // missing keys special to the project.
    // Further reading: https://developer.apple.com/library/mac/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html
    if (!opts.entitlements) {
      if (opts.verbose) console.warn('No `--entitlements` passed in arguments, will fallback to default settings.')
      opts.entitlements = path.join(__dirname, 'mas.default.plist')
    }
    if (!opts['entitlements-inherit']) {
      if (opts.verbose) console.warn('No `--entitlements-inherit` passed in arguments, will fallback to default settings.')
      opts['entitlements-inherit'] = path.join(__dirname, 'mas.inherit.default.plist')
    }
  } else if (opts.platform === 'darwin') {
    // Not necessary to have entitlements for non Mac App Store distribution
    if (opts.entitlements && opts.verbose) return cb(new Error('Unable to sign for darwin platform with entitlements.'))
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
        if (opts.verbose) console.warn('No `--identity` passed in arguments, matching identities...')
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
      console.log('> entitlements       ', opts.entitlements || false)
      console.log('> child-entitlements ', opts['entitlements-inherit'] || false)
      console.log('> additional-binaries', opts.binaries)
      console.log('> identity           ', opts.identity)
    }
    return signApplication(opts, cb)
  })
}
