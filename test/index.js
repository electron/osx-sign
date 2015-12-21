// var child = require('child_process')
// var path = require('path')

var series = require('run-series')

var util = require('./util')

series([
  function (cb) {
    console.log('Calling electron-download before running tests...')
    util.downloadElectrons(cb)
  }
], function () {
  console.log('Running tests...')
  if (process.platform !== 'darwin') {
    console.error('Unable to perform tests on non-darwin platforms.')
    process.exit(1)
  }
  require('./basic')
})
