#!/usr/bin/env node
var fs = require('fs')
var args = require('minimist')(process.argv.slice(2), {boolean: ['help']})
var usage = fs.readFileSync(__dirname + '/electron-osx-flat-usage.txt').toString()
var flat = require('../').flat

args.app = args._.shift()

if (!args.app || args.help) {
  console.log(usage)
  process.exit(0)
}

flat(args, function done (err) {
  if (err) {
    console.error('Flat failed.')
    if (err.message) console.error(err.message)
    else console.error(err.stack)
    process.exit(1)
  }
  console.log('Application flattened:', args.pkg)
  process.exit(0)
})
