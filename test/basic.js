var sign = require('..')

var waterfall = require('run-waterfall')

var config = require('./config')
var util = require('./util')

function createDefaultsTest (release) {
  return function (t) {
    t.timeoutAfter(config.timeout)

    var app = util.generateAppPath(release)
    var opts = Object.create(release)

    waterfall([
      function (cb) {
        sign(app, opts, cb)
      }, function (cb) {
        t.pass('app signed')
        cb()
      }
    ], function (err) {
      t.end(err)
    })
  }
}

util.testAllReleases('defaults-test', createDefaultsTest)
