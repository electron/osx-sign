var fs = require('fs')
var path = require('path')
var child = require('child_process')

var series = require('run-series')

function generateAppBasename (opts) {
  return path.basename(opts.app, '.app')
}

function generateAppFrameworksPath (opts) {
  return path.join(opts.app, 'Contents', 'Frameworks')
}

function generateHelperAppPath (opts, opt, suffix, callback) {
  var appFrameworksPath = generateAppFrameworksPath(opts)
  var appBasename = generateAppBasename(opts)
  if (opts[opt]) {
    // Use helper path if specified
    if (fs.existsSync(opts['helper-path'])) return opts['helper-path']
    else return callback(new Error('Specified Electron Helper not found.'))
  } else {
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

function generateHelperAppExecutablePath (opts, helperPath, suffix, callback) {
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

function signDarwinApplication (opts, callback) {
  var operations = []
  var appFrameworksPath = generateAppFrameworksPath(opts)
  var childPaths = [
    path.join(appFrameworksPath, 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework'),
    path.join(appFrameworksPath, 'Electron Framework.framework'),
    path.join(appFrameworksPath, 'Mantle.framework', 'Versions', 'A', 'Mantle'),
    path.join(appFrameworksPath, 'Mantle.framework'),
    path.join(appFrameworksPath, 'ReactiveCocoa.framework', 'Versions', 'A', 'ReactiveCocoa'),
    path.join(appFrameworksPath, 'ReactiveCocoa.framework'),
    path.join(appFrameworksPath, 'Squirrel.framework', 'Versions', 'A', 'Squirrel'),
    path.join(appFrameworksPath, 'Squirrel.framework')
  ]

  var helperPath = generateHelperAppPath(opts, 'helper-path', null, callback)
  if (helperPath) {
    var helperExecutablePath = generateHelperAppExecutablePath(opts, helperPath, null, callback)
    if (helperExecutablePath) childPaths.unshift(helperExecutablePath, helperPath)
    else return callback(new Error('Missing Electron Helper, stopped.'))
  }

  var helperEHPath = generateHelperAppPath(opts, 'helper-eh-path', ' EH', callback)
  if (helperEHPath) {
    var helperEHExecutablePath = generateHelperAppExecutablePath(opts, helperEHPath, ' EH', callback)
    if (helperEHExecutablePath) childPaths.unshift(helperEHExecutablePath, helperEHPath)
    else return callback(new Error('Missing Electron Helper EH, stopped.'))
  }

  var helperNPPath = generateHelperAppPath(opts, 'helper-np-path', ' NP', callback)
  if (helperNPPath) {
    var helperNPExecutablePath = generateHelperAppExecutablePath(opts, helperNPPath, ' NP', callback)
    if (helperNPExecutablePath) childPaths.unshift(helperNPExecutablePath, helperNPPath)
    else return callback(new Error('Missing Electron Helper NP, stopped.'))
  }

  if (opts.entitlements) {
    // TODO: Signing darwin builds with entitlements
    return callback(new Error('Entitlements not yet supported for darwin.'))
  } else {
    // Otherwise normally
    childPaths.forEach(function (path) {
      operations.push(function (cb) {
        child.exec('codesign -f -s "' + opts.identity + '" -fv \ '
          + '"' + path + '"'
        , cb)
      })
    })
    operations.push(function (cb) {
      child.exec('codesign -f -s "' + opts.identity + '" -fv \ '
        + '"' + opts.app + '"'
      , cb)
    })
  }
  // Lastly verify codesign
  operations.push(function (cb) {
    child.exec('codesign -v --verbose=4 \ '
      + '"' + opts.app + '"'
    , cb)
  })
  series(operations, function (err) {
    if (err) return callback(err)
    callback()
  })
}

function signMASApplication (opts, callback) {
  var operations = []
  var appFrameworksPath = generateAppFrameworksPath(opts)
  var childPaths = [
    path.join(appFrameworksPath, 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework'),
    path.join(appFrameworksPath, 'Electron Framework.framework')
  ]

  var helperPath = generateHelperAppPath(opts, 'helper-path', null, callback)
  if (helperPath) {
    var helperExecutablePath = generateHelperAppExecutablePath(opts, helperPath, null, callback)
    if (helperExecutablePath) childPaths.unshift(helperExecutablePath, helperPath)
    else return callback(new Error('Missing Electron Helper, stopped.'))
  }

  var helperEHPath = generateHelperAppPath(opts, 'helper-eh-path', ' EH', callback)
  if (helperEHPath) {
    var helperEHExecutablePath = generateHelperAppExecutablePath(opts, helperEHPath, ' EH', callback)
    if (helperEHExecutablePath) childPaths.unshift(helperEHExecutablePath, helperEHPath)
    else return callback(new Error('Missing Electron Helper EH, stopped.'))
  }

  var helperNPPath = generateHelperAppPath(opts, 'helper-np-path', ' NP', callback)
  if (helperNPPath) {
    var helperNPExecutablePath = generateHelperAppExecutablePath(opts, helperNPPath, ' NP', callback)
    if (helperNPExecutablePath) childPaths.unshift(helperNPExecutablePath, helperNPPath)
    else return callback(new Error('Missing Electron Helper NP, stopped.'))
  }

  // Sign with entitlements
  childPaths.forEach(function (path) {
    operations.push(function (cb) {
      child.exec('codesign -f -s "' + opts.identity + '" -fv \ '
        + '--entitlements "' + opts['entitlements-inherit'] + '" \ '
        + '"' + path + '"'
      , cb)
    })
  })
  operations.push(function (cb) {
    child.exec('codesign -f -s "' + opts.identity + '" -fv \ '
      + '--entitlements "' + opts.entitlements + '" \ '
      + '"' + opts.app + '"'
    , cb)
  })
  // Lastly verify codesign
  operations.push(function (cb) {
    child.exec('codesign -v --verbose=4 \ '
      + '"' + opts.app + '"'
    , cb)
  })
  // And check entitlements
  operations.push(function (cb) {
    child.exec('codesign -d --entitlements - \ '
      + '"' + opts.app + '"'
    , function (err, stdout, stderr) {
      if (err) return cb(err)
      if (!stdout) return cb(new Error('Entitlements failed to be signed.'))
      cb()
    })
  })
  series(operations, function (err) {
    if (err) return callback(err)
    callback()
  })
}

module.exports = function sign (app, opts, cb) {
  if (!opts) opts = {}
  opts.app = app
  if (!cb) cb = function () {}
  if (!opts.app) return cb(new Error('Path to aplication must be specified.'))
  if (!fs.existsSync(opts.app)) return cb(new Error('Application not found.'))
  if (!opts.platform || opts.platform === 'darwin') {
    opts.platform = 'darwin' // fallback to darwin if no platform specified
  } else if (opts.platform === 'mas') {
    // To sign apps for Mac App Store, an entitlements file is required,
    // especially for app sandboxing (as well some other services).
    // Fallback entitlements for sandboxing by default:
    // Note this may cause troubles while running an signed app due to
    // missing keys special to the project.
    // Further reading: https://developer.apple.com/library/mac/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html
    if (!opts.entitlements) opts.entitlements = path.join(__dirname, 'mas.default.plist')
    if (!opts['entitlements-inherit']) opts['entitlements-inherit'] = path.join(__dirname, 'mas.inherit.default.plist')
  } else {
    return cb(new Error('Only platform darwin and mas are supported.'))
  }
  series([
    function (cb) {
      if (!opts.identity) {
        child.exec('security find-identity', function (err, stdout, stderr) {
          if (err) return cb(new Error('Error in finding an identity.'))
          var lines = stdout.split('\n')
          var location
          for (var i = 0, l = lines.length; i < l && !opts.identity; i++) {
            var line = lines[i]
            if (opts.platform === 'darwin') {
              location = line.indexOf('Developer ID Application')
              if (location >= 0) {
                opts.identity = line.substring(location, line.length - 1)
                break
              }
            } else if (opts.platform === 'mas') {
              location = line.indexOf('3rd Party Mac Developer Application')
              if (location >= 0) {
                opts.identity = line.substring(location, line.length - 1)
                break
              }
            }
          }
          if (!opts.identity) cb(new Error('No identity found for signing.'))
          cb()
        })
      }
    }
  ], function (err) {
    if (err) return cb(err)
    if (opts.platform === 'darwin') {
      return signDarwinApplication(opts, cb)
    } else if (opts.platform === 'mas') {
      return signMASApplication(opts, cb)
    }
  })
}
