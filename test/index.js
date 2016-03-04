var child = require('child_process')

var series = require('run-series')

var util = require('./util')

series([
  function (cb) {
    child.exec('which codesign', cb)
  },
  function (stdout, stderr, cb) {
    if (stderr) {
      return cb(new Error('Unable to perform tests without codesign.'))
    }
    console.log('Calling electron-download before running tests...')
    util.downloadElectrons(cb)
  }
], function (err) {
  if (err) {
    console.error('Test failed.')
    if (err.message) console.error(err.message)
    else console.error(err, err.stack)
    return
  }
  console.log('Running tests...')
  if (process.platform !== 'darwin') {
    console.error('Unable to perform tests on non-darwin platforms.')
    process.exit(1)
  }
  require('./basic')
})
