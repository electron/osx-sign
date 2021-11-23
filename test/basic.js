const sign = require('..');

const waterfall = require('run-waterfall');

const config = require('./config');
const util = require('./util');

function createDefaultsTest (release) {
  return function (t) {
    t.timeoutAfter(config.timeout);

    const opts = {
      app: util.generateAppPath(release),
      identity: 'codesign.electronjs.org'
    }; // test with no other options for self discovery

    waterfall(
      [
        function (cb) {
          sign(
            {
              ...opts
            },
            cb
          );
        },
        function (cb) {
          t.pass('app signed');
          cb();
        }
      ],
      function (err) {
        t.end(err);
      }
    );
  };
}

util.testAllReleases('defaults-test', createDefaultsTest);
