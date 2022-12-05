const path = require('path');
const test = require('tape');

const { downloadArtifact } = require('@electron/get');
const mkdirp = require('mkdirp');
const rimraf = require('rimraf');
const series = require('run-series');
const compareVersion = require('compare-version');
const extract = require('extract-zip');

const config = require('./config');

const ORIGINAL_CWD = process.cwd();
const WORK_CWD = path.join(__dirname, 'work');

const versions = config.versions;
const archs = ['x64'];
const platforms = ['darwin', 'mas'];
const slice = Array.prototype.slice;

const releases = [];
versions.forEach(function (version) {
  archs.forEach(function (arch) {
    platforms.forEach(function (platform) {
      // Only versions later than 0.34.0 offer mas builds
      if (platform !== 'mas' || compareVersion(version, '0.34.0') >= 0) {
        releases.push({
          arch,
          platform,
          version
        });
      }
    });
  });
});

exports.generateReleaseName = function getExtractName (release) {
  return 'v' + release.version + '-' + release.platform + '-' + release.arch;
};

exports.generateAppPath = function getExtractName (release) {
  return path.join(exports.generateReleaseName(release), 'Electron.app');
};

exports.downloadElectrons = function downloadElectrons (callback) {
  console.log('Downloading...');
  series(
    releases.map(function (release) {
      return function (cb) {
        downloadArtifact({ ...release, artifactName: 'electron' })
          .then((zipPath) => extract(zipPath, { dir: path.join(WORK_CWD, exports.generateReleaseName(release)) }))
          .then(() => cb())
          .catch(cb);
      };
    }),
    callback
  );
};

exports.setup = function setup () {
  test('setup', function (t) {
    mkdirp(WORK_CWD).then(() => {
      process.chdir(WORK_CWD);
      t.end();
    }).catch((err) => t.end(err));
  });
};

exports.teardown = function teardown () {
  test('teardown', function (t) {
    process.chdir(ORIGINAL_CWD);
    rimraf(WORK_CWD, function (err) {
      t.end(err);
    });
  });
};

exports.forEachRelease = function forEachRelease (cb) {
  releases.forEach(cb);
};

exports.testAllReleases = function testAllReleases (name, createTest /*, ...createTestArgs */) {
  const args = slice.call(arguments, 2);
  exports.setup();
  exports.forEachRelease(function (release) {
    test(
      name + ':' + exports.generateReleaseName(release),
      createTest.apply(null, [release].concat(args))
    );
  });
  exports.teardown();
};
