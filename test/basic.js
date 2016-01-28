var sign = require('..')

var waterfall = require('run-waterfall')

var config = require('./config')
var util = require('./util')

function createDefaultsTest (release) {
  return function (t) {
    t.timeoutAfter(config.timeout)

    var opts = {
        app: util.generateAppPath(release)
    } // test with no options

    waterfall([
      function (cb) {
        sign(opts, cb)
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
